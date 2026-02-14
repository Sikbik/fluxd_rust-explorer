import type { Env } from './env.js';

export interface FluxdStatus {
  name?: string;
  version?: string;
  network?: string;
  consensus?: string;
  timestamp?: string;
  uptime?: number;

  daemon?: {
    version: string;
    protocolVersion: number;
    blocks: number;
    headers: number;
    networkHeight: number;
    bestBlockHash: string;
    difficulty: number;
    chainwork: string;
    consensus: string;
    connections: number;
  };
}

function buildAuthHeader(env: Env): string | undefined {
  if (env.rpcAuthMode === 'none') return undefined;

  if (env.rpcAuthMode === 'basic') {
    if (!env.rpcUser || !env.rpcPass) return undefined;
    return 'Basic ' + Buffer.from(`${env.rpcUser}:${env.rpcPass}`).toString('base64');
  }

  if (env.rpcAuthMode === 'cookie') {
    if (!env.rpcUser || !env.rpcPass) return undefined;
    return 'Basic ' + Buffer.from(`${env.rpcUser}:${env.rpcPass}`).toString('base64');
  }

  return undefined;
}

type BreakerState = {
  consecutiveFailures: number;
  openUntilMs: number;
  lastFailureMs: number;
};

const breakerByBaseUrl = new Map<string, BreakerState>();

function getBreaker(baseUrl: string): BreakerState {
  const prev = breakerByBaseUrl.get(baseUrl);
  if (prev) return prev;
  const next: BreakerState = { consecutiveFailures: 0, openUntilMs: 0, lastFailureMs: 0 };
  breakerByBaseUrl.set(baseUrl, next);
  return next;
}

function shouldSkip(baseUrl: string, now: number): boolean {
  const state = getBreaker(baseUrl);
  return state.openUntilMs > now;
}

function recordSuccess(baseUrl: string): void {
  const state = getBreaker(baseUrl);
  state.consecutiveFailures = 0;
  state.openUntilMs = 0;
}

function recordFailure(baseUrl: string, now: number): void {
  const state = getBreaker(baseUrl);
  state.consecutiveFailures += 1;
  state.lastFailureMs = now;

  if (state.consecutiveFailures >= 3) {
    const backoffMs = Math.min(30_000, 1_000 * 2 ** (state.consecutiveFailures - 3));
    state.openUntilMs = now + backoffMs;
  }
}

async function fluxdDaemonGetFromBaseUrl<T>(env: Env, baseUrl: string, method: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  const auth = buildAuthHeader(env);
  if (auth) headers.authorization = auth;

  const url = `${baseUrl}/daemon/${method}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`fluxd_rust /daemon/${method} failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }

  const json = (await response.json()) as any;

  if (json && typeof json === 'object' && 'result' in json) {
    return json.result as T;
  }

  return json as T;
}

async function fluxdDaemonGet<T>(env: Env, method: string): Promise<T> {
  const now = Date.now();
  const primary = env.fluxdRpcUrl;
  const secondary = env.fluxdRpcSecondaryUrl;

  const candidates: string[] = [];
  if (!shouldSkip(primary, now)) candidates.push(primary);
  if (secondary && !shouldSkip(secondary, now)) candidates.push(secondary);

  if (candidates.length === 0) {
    const fallback: string[] = [primary];
    if (secondary) fallback.push(secondary);
    candidates.push(...fallback);
  }

  let lastError: unknown;
  for (const baseUrl of candidates) {
    try {
      const result = await fluxdDaemonGetFromBaseUrl<T>(env, baseUrl, method);
      recordSuccess(baseUrl);
      return result;
    } catch (error) {
      recordFailure(baseUrl, now);
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('fluxd_rust request failed');
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  throw new Error(`invalid upstream response: ${name} not an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`invalid upstream response: ${name} not a string`);
}

function requireNumber(value: unknown, name: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(n)) return n;
  throw new Error(`invalid upstream response: ${name} not a number`);
}

export async function getDaemonStatus(env: Env): Promise<FluxdStatus> {
  if (env.fixturesMode) {
    return {
      name: 'fluxd_rust',
      version: 'fixtures',
      network: 'main',
      consensus: 'fixtures',
      daemon: {
        version: 'fixtures',
        protocolVersion: 170013,
        blocks: 1,
        headers: 1,
        networkHeight: 1,
        bestBlockHash: '0'.repeat(64),
        difficulty: 1,
        chainwork: '0x00',
        consensus: 'fixtures',
        connections: 8,
      },
      timestamp: new Date().toISOString(),
    };
  }

  const [infoRaw, chainInfoRaw, netInfoRaw, peerInfoRaw] = await Promise.all([
    fluxdDaemonGet<unknown>(env, 'getinfo'),
    fluxdDaemonGet<unknown>(env, 'getblockchaininfo'),
    fluxdDaemonGet<unknown>(env, 'getnetworkinfo'),
    fluxdDaemonGet<unknown>(env, 'getpeerinfo'),
  ]);

  const info = requireObject(infoRaw, 'getinfo');
  const chainInfo = requireObject(chainInfoRaw, 'getblockchaininfo');
  const netInfo = requireObject(netInfoRaw, 'getnetworkinfo');

  const blocks = requireNumber(info.blocks ?? chainInfo.blocks, 'blocks');
  const headers = requireNumber(info.headers ?? chainInfo.headers, 'headers');
  const peers = Array.isArray(peerInfoRaw) ? peerInfoRaw : [];
  const peerHeights = peers
    .map((peer) => Number((peer as { startingheight?: unknown }).startingheight))
    .filter((value) => Number.isFinite(value) && value > 0);
  const peerBest = peerHeights.length > 0 ? Math.max(...peerHeights) : 0;
  const networkHeight = Math.max(headers, peerBest);

  return {
    name: 'fluxd_rust',
    version: typeof info.version === 'string' ? info.version : undefined,
    network: typeof chainInfo.chain === 'string' ? chainInfo.chain : undefined,
    consensus: typeof chainInfo.consensus === 'string' ? chainInfo.consensus : undefined,
    daemon: {
      version: String(info.version ?? ''),
      protocolVersion: requireNumber(info.protocolversion ?? info.protocolVersion ?? 0, 'protocolVersion'),
      blocks,
      headers,
      networkHeight,
      bestBlockHash: requireString(chainInfo.bestblockhash ?? '', 'bestBlockHash'),
      difficulty: requireNumber(chainInfo.difficulty ?? 0, 'difficulty'),
      chainwork: String(chainInfo.chainwork ?? ''),
      consensus: String(chainInfo.consensus ?? ''),
      connections: requireNumber(netInfo.connections ?? 0, 'connections'),
    },
    timestamp: new Date().toISOString(),
  };
}
