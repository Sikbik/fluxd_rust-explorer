export type RpcAuthMode = 'cookie' | 'basic' | 'none';

export interface RateLimitPolicyConfig {
  cost: number;
  concurrentLimit: number;
  blockMs: number;
  penaltyThreshold: number;
  penaltyWindowMs: number;
}

export interface RateLimitConfig {
  capacity: number;
  refillPerSec: number;
  stateTtlMs: number;
  defaultPolicy: RateLimitPolicyConfig;
  heavyPolicy: RateLimitPolicyConfig;
  veryHeavyPolicy: RateLimitPolicyConfig;
  richListCost: number;
  richListConcurrentLimit: number;
}

export interface Env {
  port: number;
  fluxdRpcUrl: string;
  fluxdRpcSecondaryUrl?: string;
  rpcAuthMode: RpcAuthMode;
  rpcUser?: string;
  rpcPass?: string;
  fixturesMode: boolean;
  rateLimit: RateLimitConfig;
}

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host.endsWith('.localhost')) return true;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map((p) => Number(p));
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
}

function readPositiveIntEnv(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < minValue) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }

  return parsed;
}

export function readEnv(): Env {
  const fixturesMode = process.env.FIXTURES_MODE === '1' || process.env.FIXTURES_MODE === 'true';
  const port = parseInt(process.env.PORT ?? '42067', 10);
  const fluxdRpcUrl = process.env.FLUXD_RPC_URL ?? 'http://fluxd:16124';
  const rpcAuthMode = (process.env.FLUXD_RPC_AUTH_MODE ?? (fixturesMode ? 'none' : 'none')) as RpcAuthMode;

  const rpcUser = process.env.FLUXD_RPC_USER;
  const rpcPass = process.env.FLUXD_RPC_PASS;

  const fluxdRpcSecondaryUrl = process.env.FLUXD_RPC_SECONDARY_URL;

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const validateUpstreamUrl = (label: string, raw: string): void => {
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      throw new Error(`${label} must be http(s): ${raw}`);
    }

    const url = new URL(raw);
    if (url.username || url.password) {
      throw new Error(`${label} must not include credentials`);
    }

    if (isPrivateAddress(url.hostname)) {
      const allowedPrivateHosts = new Set(['fluxd', 'localhost', '127.0.0.1']);
      if (!allowedPrivateHosts.has(url.hostname.toLowerCase())) {
        throw new Error(`${label} hostname not allowed: ${url.hostname}`);
      }
    }
  };

  if (!fixturesMode) {
    validateUpstreamUrl('FLUXD_RPC_URL', fluxdRpcUrl);

    if (fluxdRpcSecondaryUrl) {
      validateUpstreamUrl('FLUXD_RPC_SECONDARY_URL', fluxdRpcSecondaryUrl);
    }
  }

  if (!['cookie', 'basic', 'none'].includes(rpcAuthMode)) {
    throw new Error(`Invalid FLUXD_RPC_AUTH_MODE: ${rpcAuthMode}`);
  }

  if (!fixturesMode && rpcAuthMode === 'basic') {
    if (!rpcUser || !rpcPass) {
      throw new Error('FLUXD_RPC_AUTH_MODE=basic requires FLUXD_RPC_USER and FLUXD_RPC_PASS');
    }
  }

  const rateLimit: RateLimitConfig = {
    capacity: readPositiveIntEnv('RATE_LIMIT_CAPACITY', 240),
    refillPerSec: readPositiveIntEnv('RATE_LIMIT_REFILL_PER_SEC', 8),
    stateTtlMs: readPositiveIntEnv('RATE_LIMIT_STATE_TTL_MS', 10 * 60_000),
    defaultPolicy: {
      cost: readPositiveIntEnv('RATE_LIMIT_DEFAULT_COST', 1),
      concurrentLimit: readPositiveIntEnv('RATE_LIMIT_DEFAULT_CONCURRENT_LIMIT', 24),
      blockMs: readPositiveIntEnv('RATE_LIMIT_DEFAULT_BLOCK_MS', 2_000),
      penaltyThreshold: readPositiveIntEnv('RATE_LIMIT_DEFAULT_PENALTY_THRESHOLD', 12),
      penaltyWindowMs: readPositiveIntEnv('RATE_LIMIT_DEFAULT_PENALTY_WINDOW_MS', 45_000),
    },
    heavyPolicy: {
      cost: readPositiveIntEnv('RATE_LIMIT_HEAVY_COST', 8),
      concurrentLimit: readPositiveIntEnv('RATE_LIMIT_HEAVY_CONCURRENT_LIMIT', 2),
      blockMs: readPositiveIntEnv('RATE_LIMIT_HEAVY_BLOCK_MS', 3_000),
      penaltyThreshold: readPositiveIntEnv('RATE_LIMIT_HEAVY_PENALTY_THRESHOLD', 6),
      penaltyWindowMs: readPositiveIntEnv('RATE_LIMIT_HEAVY_PENALTY_WINDOW_MS', 60_000),
    },
    veryHeavyPolicy: {
      cost: readPositiveIntEnv('RATE_LIMIT_VERY_HEAVY_COST', 12),
      concurrentLimit: readPositiveIntEnv('RATE_LIMIT_VERY_HEAVY_CONCURRENT_LIMIT', 1),
      blockMs: readPositiveIntEnv('RATE_LIMIT_VERY_HEAVY_BLOCK_MS', 5_000),
      penaltyThreshold: readPositiveIntEnv('RATE_LIMIT_VERY_HEAVY_PENALTY_THRESHOLD', 5),
      penaltyWindowMs: readPositiveIntEnv('RATE_LIMIT_VERY_HEAVY_PENALTY_WINDOW_MS', 90_000),
    },
    richListCost: readPositiveIntEnv('RATE_LIMIT_RICHLIST_COST', 6),
    richListConcurrentLimit: readPositiveIntEnv('RATE_LIMIT_RICHLIST_CONCURRENT_LIMIT', 2),
  };

  return {
    port,
    fluxdRpcUrl,
    fluxdRpcSecondaryUrl,
    rpcAuthMode,
    rpcUser,
    rpcPass,
    fixturesMode,
    rateLimit,
  };
}
