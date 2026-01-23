export type RpcAuthMode = 'cookie' | 'basic' | 'none';

export interface Env {
  port: number;
  fluxdRpcUrl: string;
  rpcAuthMode: RpcAuthMode;
  rpcUser?: string;
  rpcPass?: string;
}

export function readEnv(): Env {
  const port = parseInt(process.env.PORT ?? '42067', 10);
  const fluxdRpcUrl = process.env.FLUXD_RPC_URL ?? 'http://fluxd:16124';
  const rpcAuthMode = (process.env.FLUXD_RPC_AUTH_MODE ?? 'none') as RpcAuthMode;

  const rpcUser = process.env.FLUXD_RPC_USER;
  const rpcPass = process.env.FLUXD_RPC_PASS;

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  if (!fluxdRpcUrl.startsWith('http://') && !fluxdRpcUrl.startsWith('https://')) {
    throw new Error(`FLUXD_RPC_URL must be http(s): ${fluxdRpcUrl}`);
  }

  if (!['cookie', 'basic', 'none'].includes(rpcAuthMode)) {
    throw new Error(`Invalid FLUXD_RPC_AUTH_MODE: ${rpcAuthMode}`);
  }

  if (rpcAuthMode === 'basic') {
    if (!rpcUser || !rpcPass) {
      throw new Error('FLUXD_RPC_AUTH_MODE=basic requires FLUXD_RPC_USER and FLUXD_RPC_PASS');
    }
  }

  return { port, fluxdRpcUrl, rpcAuthMode, rpcUser, rpcPass };
}
