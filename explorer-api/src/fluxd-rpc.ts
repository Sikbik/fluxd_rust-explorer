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

async function fluxdDaemonGet<T>(env: Env, method: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  const auth = buildAuthHeader(env);
  if (auth) headers.authorization = auth;

  const url = `${env.fluxdRpcUrl}/daemon/${method}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
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

export async function getDaemonStatus(env: Env): Promise<FluxdStatus> {
  const [info, chainInfo, netInfo] = await Promise.all([
    fluxdDaemonGet<any>(env, 'getinfo'),
    fluxdDaemonGet<any>(env, 'getblockchaininfo'),
    fluxdDaemonGet<any>(env, 'getnetworkinfo'),
  ]);

  return {
    name: 'fluxd_rust',
    version: typeof info?.version === 'string' ? info.version : undefined,
    network: typeof chainInfo?.chain === 'string' ? chainInfo.chain : undefined,
    consensus: typeof chainInfo?.consensus === 'string' ? chainInfo.consensus : undefined,
    daemon: {
      version: Number.isFinite(info?.version) ? String(info.version) : (typeof info?.version === 'string' ? info.version : ''),
      protocolVersion: Number(info?.protocolversion ?? info?.protocolVersion ?? 0),
      blocks: Number(info?.blocks ?? chainInfo?.blocks ?? 0),
      headers: Number(info?.headers ?? chainInfo?.headers ?? 0),
      bestBlockHash: String(chainInfo?.bestblockhash ?? ''),
      difficulty: Number(chainInfo?.difficulty ?? 0),
      chainwork: String(chainInfo?.chainwork ?? ''),
      consensus: String(chainInfo?.consensus ?? ''),
      connections: Number(netInfo?.connections ?? 0),
    },
    timestamp: new Date().toISOString(),
  };
}
