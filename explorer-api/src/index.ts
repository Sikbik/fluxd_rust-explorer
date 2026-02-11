import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { readEnv } from './env.js';
import { getDaemonStatus } from './fluxd-rpc.js';
import { noteSelfCheckResult, registerRoutes } from './routes.js';

const app: Express = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

const env = readEnv();

app.set('trust proxy', true);

app.use((req, res, next) => {
  const existing = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null;
  const requestId = existing && existing.length <= 128 ? existing : randomUUID();

  res.setHeader('x-request-id', requestId);
  (req as unknown as { requestId: string }).requestId = requestId;

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (req.path === '/health' || req.path === '/metrics') return;

    const ip = req.ip ?? 'unknown';
    const method = req.method;
    const status = res.statusCode;

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        requestId,
        ip,
        method,
        path: req.path,
        status,
        elapsedMs: Math.round(elapsedMs),
      })
    );
  });

  next();
});

type RateState = {
  tokens: number;
  lastRefillMs: number;
  blockedUntilMs: number;
  hits: number;
  penalties: number;
};

type RatePolicy = {
  cost: number;
  concurrentLimit: number;
  blockMs: number;
  penaltyThreshold: number;
  penaltyWindowMs: number;
};

const rateState = new Map<string, RateState>();
const inFlightByIpPath = new Map<string, number>();
const bannedIps = new Map<string, { untilMs: number; reason: string }>();

const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SEC = 8;
const RATE_LIMIT_STATE_TTL_MS = 10 * 60_000;

const DEFAULT_POLICY: RatePolicy = {
  cost: 1,
  concurrentLimit: 24,
  blockMs: 2_000,
  penaltyThreshold: 12,
  penaltyWindowMs: 45_000,
};

const HEAVY_POLICY: RatePolicy = {
  cost: 8,
  concurrentLimit: 2,
  blockMs: 3_000,
  penaltyThreshold: 6,
  penaltyWindowMs: 60_000,
};

const VERY_HEAVY_POLICY: RatePolicy = {
  cost: 12,
  concurrentLimit: 1,
  blockMs: 5_000,
  penaltyThreshold: 5,
  penaltyWindowMs: 90_000,
};

let lastSweptMs = Date.now();

function sweepMaps(now: number): void {
  for (const [key, value] of rateState) {
    if (now - value.lastRefillMs > RATE_LIMIT_STATE_TTL_MS) {
      rateState.delete(key);
    }
  }

  for (const [ip, ban] of bannedIps) {
    if (ban.untilMs <= now) {
      bannedIps.delete(ip);
    }
  }
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isTrustedInternalIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('172.18.')) return true;
  return false;
}

function normalizeRatePath(path: string): string {
  if (path.startsWith('/api/v1/addresses/') && path.endsWith('/transactions')) {
    return '/api/v1/addresses/:address/transactions';
  }
  if (path === '/api/v1/transactions/batch') {
    return '/api/v1/transactions/batch';
  }
  if (path === '/api/v1/blocks/range') {
    return '/api/v1/blocks/range';
  }
  if (path === '/api/v1/richlist') {
    return '/api/v1/richlist';
  }
  return path;
}

function ratePolicyFor(method: string, normalizedPath: string): RatePolicy {
  if (method === 'POST' && normalizedPath === '/api/v1/transactions/batch') {
    return VERY_HEAVY_POLICY;
  }

  if (
    normalizedPath === '/api/v1/addresses/:address/transactions' ||
    normalizedPath === '/api/v1/blocks/range'
  ) {
    return HEAVY_POLICY;
  }

  if (normalizedPath === '/api/v1/richlist') {
    return { ...HEAVY_POLICY, cost: 6, concurrentLimit: 2 };
  }

  return DEFAULT_POLICY;
}

app.use((req, res, next) => {
  const path = req.path;
  if (path === '/health' || path.startsWith('/favicon')) {
    next();
    return;
  }

  if (path === '/metrics') {
    next();
    return;
  }

  if (!path.startsWith('/api/v1/')) {
    next();
    return;
  }

  const ip = normalizeIp(req.ip ?? 'unknown');
  if (isTrustedInternalIp(ip)) {
    next();
    return;
  }

  const normalizedPath = normalizeRatePath(path);
  const policy = ratePolicyFor(req.method, normalizedPath);

  const now = Date.now();
  if (now - lastSweptMs > 60_000) {
    lastSweptMs = now;
    sweepMaps(now);
  }

  const ban = bannedIps.get(ip);
  if (ban && ban.untilMs > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((ban.untilMs - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited', retryAfterSeconds, reason: ban.reason });
    return;
  }

  const prev = rateState.get(ip);
  const state = prev ?? {
    tokens: RATE_LIMIT_CAPACITY,
    lastRefillMs: now,
    blockedUntilMs: 0,
    hits: 0,
    penalties: 0,
  };

  if (state.blockedUntilMs > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((state.blockedUntilMs - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited', retryAfterSeconds });
    return;
  }

  const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
  const refill = elapsedSec * RATE_LIMIT_REFILL_PER_SEC;
  state.tokens = Math.min(RATE_LIMIT_CAPACITY, state.tokens + refill);
  state.lastRefillMs = now;

  const inFlightKey = `${ip}:${normalizedPath}`;
  const inFlightCount = inFlightByIpPath.get(inFlightKey) ?? 0;

  const applyPenalty = (reason: string): number => {
    state.blockedUntilMs = now + policy.blockMs;
    state.penalties += 1;
    rateState.set(ip, state);

    if (state.penalties >= policy.penaltyThreshold) {
      bannedIps.set(ip, { untilMs: now + policy.penaltyWindowMs, reason });
      state.penalties = 0;
      rateState.set(ip, state);
      return Math.max(1, Math.ceil(policy.penaltyWindowMs / 1000));
    }

    return Math.max(1, Math.ceil(policy.blockMs / 1000));
  };

  const emitRateHeaders = (): void => {
    const remaining = Math.max(0, Math.floor(state.tokens));
    const resetSeconds = Math.max(
      1,
      Math.ceil((RATE_LIMIT_CAPACITY - Math.min(state.tokens, RATE_LIMIT_CAPACITY)) / RATE_LIMIT_REFILL_PER_SEC)
    );
    res.setHeader('x-ratelimit-limit', String(RATE_LIMIT_CAPACITY));
    res.setHeader('x-ratelimit-remaining', String(remaining));
    res.setHeader('x-ratelimit-reset', String(resetSeconds));
  };

  if (inFlightCount >= policy.concurrentLimit) {
    const retryAfterSeconds = applyPenalty('concurrency_limit');
    emitRateHeaders();
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited', retryAfterSeconds, reason: 'concurrency_limit' });
    return;
  }

  if (state.tokens < policy.cost) {
    const retryAfterSeconds = applyPenalty('burst_limit');
    emitRateHeaders();
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited', retryAfterSeconds, reason: 'burst_limit' });
    return;
  }

  state.tokens -= policy.cost;
  state.hits += 1;
  rateState.set(ip, state);
  emitRateHeaders();

  inFlightByIpPath.set(inFlightKey, inFlightCount + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = inFlightByIpPath.get(inFlightKey) ?? 0;
    if (current <= 1) {
      inFlightByIpPath.delete(inFlightKey);
    } else {
      inFlightByIpPath.set(inFlightKey, current - 1);
    }
  };
  res.on('finish', release);
  res.on('close', release);

  next();
});

registerRoutes(app, env);

app.listen(env.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`explorer-api listening on 0.0.0.0:${env.port}`);

  let warmupInterval: NodeJS.Timeout | null = null;

  async function runWarmups(): Promise<void> {
    fetch(`http://127.0.0.1:${env.port}/api/v1/supply`).catch(() => undefined);
    fetch(`http://127.0.0.1:${env.port}/api/v1/blocks/latest?limit=6`).catch(() => undefined);
    fetch(`http://127.0.0.1:${env.port}/api/v1/stats/dashboard`).catch(() => undefined);
  }

  async function startWarmupsWhenReady(): Promise<void> {
    const deadlineMs = Date.now() + 90_000;

    while (Date.now() < deadlineMs) {
      try {
        await getDaemonStatus(env);
        await runWarmups();

        if (!warmupInterval) {
          warmupInterval = setInterval(() => {
            void runWarmups();
          }, 60_000);
        }

        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  void startWarmupsWhenReady();

  let lastSelfCheckAt: number | null = null;
  let lastSelfCheckOk: boolean | null = null;
  let lastSelfCheckError: string | null = null;
  let selfCheckInFlight: Promise<void> | null = null;

  async function runSelfCheck(now: number): Promise<void> {
    try {
      const verify = await fetch(`${env.fluxdRpcUrl}/daemon/verifychain?params=${encodeURIComponent(JSON.stringify([1, 6]))}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!verify.ok) {
        throw new Error(`verifychain failed: ${verify.status} ${verify.statusText}`);
      }
      const verifyJson = (await verify.json()) as any;
      const ok = verifyJson && typeof verifyJson === 'object' && 'result' in verifyJson ? Boolean(verifyJson.result) : Boolean(verifyJson);
      if (!ok) {
        throw new Error('verifychain returned false');
      }

      lastSelfCheckAt = now;
      lastSelfCheckOk = true;
      lastSelfCheckError = null;
      noteSelfCheckResult(now, true);
    } catch (error) {
      lastSelfCheckAt = now;
      lastSelfCheckOk = false;
      lastSelfCheckError = error instanceof Error ? error.message : String(error);
      noteSelfCheckResult(now, false);
    }
  }

  app.get('/api/self-check', (_req, res) => {
    res.status(200).json({
      lastSelfCheckAt,
      lastSelfCheckOk,
      lastSelfCheckError,
    });
  });

  setInterval(() => {
    const now = Date.now();
    if (selfCheckInFlight) return;
    selfCheckInFlight = runSelfCheck(now).finally(() => {
      selfCheckInFlight = null;
    });
  }, 10 * 60_000);

});
