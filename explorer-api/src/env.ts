export type RpcAuthMode = 'cookie' | 'basic' | 'none';

export interface Env {
  port: number;
  fluxdRpcUrl: string;
  fluxdRpcSecondaryUrl?: string;
  rpcAuthMode: RpcAuthMode;
  rpcUser?: string;
  rpcPass?: string;
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

export function readEnv(): Env {
  const port = parseInt(process.env.PORT ?? '42067', 10);
  const fluxdRpcUrl = process.env.FLUXD_RPC_URL ?? 'http://fluxd:16124';
  const rpcAuthMode = (process.env.FLUXD_RPC_AUTH_MODE ?? 'none') as RpcAuthMode;

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

  validateUpstreamUrl('FLUXD_RPC_URL', fluxdRpcUrl);

  if (fluxdRpcSecondaryUrl) {
    validateUpstreamUrl('FLUXD_RPC_SECONDARY_URL', fluxdRpcSecondaryUrl);
  }

  if (!['cookie', 'basic', 'none'].includes(rpcAuthMode)) {
    throw new Error(`Invalid FLUXD_RPC_AUTH_MODE: ${rpcAuthMode}`);
  }

  if (rpcAuthMode === 'basic') {
    if (!rpcUser || !rpcPass) {
      throw new Error('FLUXD_RPC_AUTH_MODE=basic requires FLUXD_RPC_USER and FLUXD_RPC_PASS');
    }
  }

  return { port, fluxdRpcUrl, fluxdRpcSecondaryUrl, rpcAuthMode, rpcUser, rpcPass };
}
