import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type ExportTokenPayload = {
  v: 1;
  ip: string;
  address: string;
  fromTimestamp: number;
  toTimestamp: number;
  maxLimit: number;
  exp: number;
  nonce: string;
};

type VerifyExportTokenInput = {
  token: string;
  ip: string;
  address: string;
  fromTimestamp: number;
  toTimestamp: number;
  limit: number;
};

type QuotaState = {
  tokens: number;
  lastRefillMs: number;
  blockedUntilMs: number;
};

type QuotaConfig = {
  capacity: number;
  refillPerSec: number;
  blockMs: number;
  cost: number;
};

const EXPORT_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const EXPORT_SECRET =
  process.env.EXPORT_GUARD_SECRET || randomBytes(32).toString("hex");

const SESSION_QUOTA_CONFIG: QuotaConfig = {
  capacity: 6,
  refillPerSec: 0.1,
  blockMs: 60_000,
  cost: 1,
};

const EXPORT_REQUEST_QUOTA_CONFIG: QuotaConfig = {
  capacity: 60,
  refillPerSec: 1.2,
  blockMs: 30_000,
  cost: 1,
};

const sessionQuota = new Map<string, QuotaState>();
const requestQuota = new Map<string, QuotaState>();
const QUOTA_STATE_TTL_MS = 10 * 60_000;
let lastSweepMs = 0;

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const padding = 4 - (input.length % 4 || 4);
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .concat("=".repeat(padding));
  return Buffer.from(base64, "base64");
}

function signPayload(payloadSegment: string): string {
  const digest = createHmac("sha256", EXPORT_SECRET)
    .update(payloadSegment)
    .digest();
  return toBase64Url(digest);
}

function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isTimestamp(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function isLikelyFluxAddress(address: string): boolean {
  return /^t[13][a-zA-Z0-9]{33}$/.test(address);
}

export function issueExportToken(input: {
  ip: string;
  address: string;
  fromTimestamp: number;
  toTimestamp: number;
  maxLimit: number;
}): { token: string; expiresAt: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: ExportTokenPayload = {
    v: 1,
    ip: normalizeIp(input.ip),
    address: input.address,
    fromTimestamp: input.fromTimestamp,
    toTimestamp: input.toTimestamp,
    maxLimit: input.maxLimit,
    exp: nowSec + EXPORT_TOKEN_TTL_SECONDS,
    nonce: randomBytes(8).toString("hex"),
  };

  const payloadSegment = toBase64Url(JSON.stringify(payload));
  const signatureSegment = signPayload(payloadSegment);

  return {
    token: `${payloadSegment}.${signatureSegment}`,
    expiresAt: payload.exp,
  };
}

export function verifyExportToken(input: VerifyExportTokenInput): {
  ok: boolean;
  reason?: string;
} {
  const [payloadSegment, signatureSegment] = input.token.split(".");
  if (!payloadSegment || !signatureSegment) {
    return { ok: false, reason: "missing_token_parts" };
  }

  const expectedSignature = signPayload(payloadSegment);
  let actualSignature: Buffer;
  let expectedSignatureBuf: Buffer;
  try {
    actualSignature = fromBase64Url(signatureSegment);
    expectedSignatureBuf = fromBase64Url(expectedSignature);
  } catch {
    return { ok: false, reason: "invalid_signature_encoding" };
  }
  if (
    actualSignature.length !== expectedSignatureBuf.length ||
    !timingSafeEqual(actualSignature, expectedSignatureBuf)
  ) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: ExportTokenPayload;
  try {
    payload = JSON.parse(fromBase64Url(payloadSegment).toString("utf8")) as ExportTokenPayload;
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.v !== 1) return { ok: false, reason: "unsupported_version" };
  if (!isTimestamp(payload.fromTimestamp) || !isTimestamp(payload.toTimestamp)) {
    return { ok: false, reason: "invalid_timestamps" };
  }
  if (!isTimestamp(payload.exp)) return { ok: false, reason: "invalid_expiry" };
  if (payload.exp < nowSec) return { ok: false, reason: "expired" };

  if (normalizeIp(payload.ip) !== normalizeIp(input.ip)) {
    return { ok: false, reason: "ip_mismatch" };
  }
  if (payload.address !== input.address) {
    return { ok: false, reason: "address_mismatch" };
  }
  if (payload.fromTimestamp !== input.fromTimestamp || payload.toTimestamp !== input.toTimestamp) {
    return { ok: false, reason: "range_mismatch" };
  }
  if (!Number.isFinite(input.limit) || input.limit <= 0 || input.limit > payload.maxLimit) {
    return { ok: false, reason: "limit_mismatch" };
  }

  return { ok: true };
}

function sweepQuotaMaps(nowMs: number): void {
  if (nowMs - lastSweepMs < 60_000) return;
  lastSweepMs = nowMs;

  sessionQuota.forEach((state, key) => {
    if (
      nowMs - state.lastRefillMs > QUOTA_STATE_TTL_MS &&
      state.blockedUntilMs <= nowMs
    ) {
      sessionQuota.delete(key);
    }
  });

  requestQuota.forEach((state, key) => {
    if (
      nowMs - state.lastRefillMs > QUOTA_STATE_TTL_MS &&
      state.blockedUntilMs <= nowMs
    ) {
      requestQuota.delete(key);
    }
  });
}

function consumeQuota(
  map: Map<string, QuotaState>,
  key: string,
  config: QuotaConfig
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const nowMs = Date.now();
  sweepQuotaMaps(nowMs);

  const current = map.get(key) ?? {
    tokens: config.capacity,
    lastRefillMs: nowMs,
    blockedUntilMs: 0,
  };

  if (current.blockedUntilMs > nowMs) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.blockedUntilMs - nowMs) / 1000)
    );
    return { ok: false, retryAfterSeconds };
  }

  const elapsedSec = Math.max(0, (nowMs - current.lastRefillMs) / 1000);
  current.tokens = Math.min(
    config.capacity,
    current.tokens + elapsedSec * config.refillPerSec
  );
  current.lastRefillMs = nowMs;

  if (current.tokens < config.cost) {
    current.blockedUntilMs = nowMs + config.blockMs;
    map.set(key, current);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil(config.blockMs / 1000)),
    };
  }

  current.tokens -= config.cost;
  map.set(key, current);
  return { ok: true };
}

export function consumeExportSessionQuota(ip: string): {
  ok: boolean;
  retryAfterSeconds?: number;
} {
  return consumeQuota(sessionQuota, normalizeIp(ip), SESSION_QUOTA_CONFIG);
}

export function consumeExportRequestQuota(ip: string): {
  ok: boolean;
  retryAfterSeconds?: number;
} {
  return consumeQuota(requestQuota, normalizeIp(ip), EXPORT_REQUEST_QUOTA_CONFIG);
}
