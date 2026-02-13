import express, { type Express, type Request, type Response } from 'express';
import type { Env } from './env.js';
import { getDaemonStatus } from './fluxd-rpc.js';
import {
  getAddressSummary,
  getAddressBalances,
  getAddressNeighbors,
  getAddressTransactions,
  getAddressUtxos,
  getBlockByHash,
  getBlockByHeight,
  getLatestBlocks,
  getBlocksRange,
  getTransaction,
  getSupplyStats,
  getDashboardStats,
  getIndexStats,
  getRichList,
} from './fluxindexer-adapter.js';
import { fluxdGet } from './fluxindexer-adapter.js';

function toInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function badRequest(res: Response, error: string, message?: string): void {
  res.status(400).json({ error, message });
}

function upstreamUnavailable(res: Response, error: string, message?: string): void {
  res.status(502).json({ error, message });
}

function notFound(res: Response, error: string, message?: string): void {
  res.status(404).json({ error, message });
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isHexString(value: string, len: number): boolean {
  if (value.length !== len) return false;
  return /^[0-9a-fA-F]+$/.test(value);
}

export interface MetricsSnapshot {
  startedAtMs: number;
  requestsTotal: number;
  inFlight: number;
  byPath: Record<string, { requests: number; errors: number; statusCounts: Record<string, number>; totalMs: number }>;
  selfCheckRuns: number;
  selfCheckFailures: number;
  selfCheckLastAtMs: number | null;
  selfCheckLastOk: boolean | null;
}

const metricsState: MetricsSnapshot = {
  startedAtMs: Date.now(),
  requestsTotal: 0,
  inFlight: 0,
  byPath: {},
  selfCheckRuns: 0,
  selfCheckFailures: 0,
  selfCheckLastAtMs: null,
  selfCheckLastOk: null,
};

export function noteSelfCheckResult(atMs: number, ok: boolean): void {
  metricsState.selfCheckRuns += 1;
  metricsState.selfCheckLastAtMs = atMs;
  metricsState.selfCheckLastOk = ok;
  if (!ok) metricsState.selfCheckFailures += 1;
}

export function getMetricsSnapshot(): MetricsSnapshot {
  return {
    startedAtMs: metricsState.startedAtMs,
    requestsTotal: metricsState.requestsTotal,
    inFlight: metricsState.inFlight,
    byPath: JSON.parse(JSON.stringify(metricsState.byPath)) as MetricsSnapshot['byPath'],
    selfCheckRuns: metricsState.selfCheckRuns,
    selfCheckFailures: metricsState.selfCheckFailures,
    selfCheckLastAtMs: metricsState.selfCheckLastAtMs,
    selfCheckLastOk: metricsState.selfCheckLastOk,
  };
}

function normalizePath(path: string): string {
  if (path.startsWith('/api/v1/blocks/')) {
    if (path === '/api/v1/blocks/latest') return '/api/v1/blocks/latest';
    if (path === '/api/v1/blocks/range') return '/api/v1/blocks/range';
    return '/api/v1/blocks/:hashOrHeight';
  }

  if (path.startsWith('/api/v1/transactions/')) {
    if (path === '/api/v1/transactions/batch') return '/api/v1/transactions/batch';
    return '/api/v1/transactions/:txid';
  }

  if (path.startsWith('/api/v1/addresses/')) {
    if (path === '/api/v1/addresses/balances') return '/api/v1/addresses/balances';
    if (path.endsWith('/transactions')) return '/api/v1/addresses/:address/transactions';
    if (path.endsWith('/utxos')) return '/api/v1/addresses/:address/utxos';
    if (path.endsWith('/neighbors')) return '/api/v1/addresses/:address/neighbors';
    return '/api/v1/addresses/:address';
  }

  return path;
}

const STARTUP_GRACE_PERIOD_MS = 2 * 60_000;
const WARMUP_RETRY_AFTER_SECONDS = 3;
const RICH_LIST_FRESH_MS = 60_000;
const RICH_LIST_MAX_AGE_MS = 2 * 60_000;
const RICH_LIST_WARMUP_MAX_AGE_MS = 15_000;
const RICH_LIST_WARMUP_MIN_REFRESH_MS = 1_000;
const RICH_LIST_WARMUP_MAX_REFRESH_MS = 10_000;

function isStartupGracePeriod(nowMs: number): boolean {
  return nowMs - metricsState.startedAtMs <= STARTUP_GRACE_PERIOD_MS;
}

function looksLikeWarmupError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('warming up') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('socket hang up') ||
    normalized.includes('timed out') ||
    normalized.includes('headers timeout') ||
    normalized.includes('connection reset')
  );
}

function isRichListWarmupPayload(value: unknown): boolean {
  const payload = value as { warmingUp?: unknown; degraded?: unknown };
  return payload?.warmingUp === true || payload?.degraded === true;
}

function getRichListRefreshIntervalMs(value: unknown): number {
  if (!isRichListWarmupPayload(value)) {
    return RICH_LIST_FRESH_MS;
  }

  const payload = value as { retryAfterSeconds?: unknown };
  const retryAfterSeconds = toInt(payload?.retryAfterSeconds) ?? WARMUP_RETRY_AFTER_SECONDS;
  const retryAfterMs = retryAfterSeconds * 1000;

  return Math.max(
    RICH_LIST_WARMUP_MIN_REFRESH_MS,
    Math.min(RICH_LIST_WARMUP_MAX_REFRESH_MS, retryAfterMs)
  );
}

function getRichListMaxAgeMs(value: unknown): number {
  return isRichListWarmupPayload(value) ? RICH_LIST_WARMUP_MAX_AGE_MS : RICH_LIST_MAX_AGE_MS;
}

function buildHomeWarmupPayload(
  nowMs: number,
  statusPayload: unknown,
  dashboardPayload: unknown,
  message: string
): Record<string, unknown> {
  const status = (statusPayload ?? {}) as any;
  const dashboard = (dashboardPayload ?? null) as any;

  const tipHeight =
    toInt(status?.indexer?.currentHeight) ??
    toInt(status?.daemon?.blocks) ??
    toInt(dashboard?.latestBlock?.height) ??
    0;

  const tipHash =
    typeof status?.daemon?.bestBlockHash === 'string'
      ? status.daemon.bestBlockHash
      : typeof dashboard?.latestBlock?.hash === 'string'
        ? dashboard.latestBlock.hash
        : null;

  const tipTime =
    toInt(status?.timestamp ? Date.parse(status.timestamp) / 1000 : null) ??
    toInt(dashboard?.latestBlock?.timestamp) ??
    null;

  return {
    tipHeight,
    tipHash,
    tipTime,
    latestBlocks: [],
    dashboard: dashboard ?? null,
    warmingUp: true,
    degraded: true,
    retryAfterSeconds: WARMUP_RETRY_AFTER_SECONDS,
    message,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

function buildRichListWarmupPayload(
  nowMs: number,
  page: number,
  pageSize: number,
  minBalance: number,
  lastBlockHeight: number,
  message: string
): Record<string, unknown> {
  return {
    lastUpdate: new Date(nowMs).toISOString(),
    lastBlockHeight,
    totalSupply: '0',
    totalAddresses: 0,
    page,
    pageSize,
    totalPages: 0,
    minBalance,
    addresses: [],
    warmingUp: true,
    degraded: true,
    retryAfterSeconds: WARMUP_RETRY_AFTER_SECONDS,
    message,
  };
}

export function registerRoutes(app: Express, env: Env) {
  app.use('/api/v1', (req: Request, res: Response, next) => {
    const startedAt = Date.now();
    metricsState.requestsTotal += 1;
    metricsState.inFlight += 1;

    res.on('finish', () => {
      const elapsedMs = Date.now() - startedAt;
      metricsState.inFlight = Math.max(0, metricsState.inFlight - 1);

      const key = normalizePath(req.path);
      const entry =
        metricsState.byPath[key] ??
        { requests: 0, errors: 0, statusCounts: {}, totalMs: 0 };

      entry.requests += 1;
      entry.totalMs += elapsedMs;

      const statusKey = String(res.statusCode);
      entry.statusCounts[statusKey] = (entry.statusCounts[statusKey] ?? 0) + 1;
      if (res.statusCode >= 500) entry.errors += 1;

      metricsState.byPath[key] = entry;
    });

    next();
  });
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await getDaemonStatus(env);
      res.status(200).json({ ok: true, service: 'explorer-api', dependencies: { fluxd: 'ok' } });
    } catch {
      res.status(503).json({ ok: false, service: 'explorer-api', dependencies: { fluxd: 'error' } });
    }
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await getDaemonStatus(env);
      res.status(200).json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    const snapshot = getMetricsSnapshot();

    let body = '';
    body += `# HELP explorer_api_requests_total Total requests handled by explorer-api\n`;
    body += `# TYPE explorer_api_requests_total counter\n`;
    body += `explorer_api_requests_total ${snapshot.requestsTotal}\n`;

    body += `# HELP explorer_api_requests_in_flight In-flight requests\n`;
    body += `# TYPE explorer_api_requests_in_flight gauge\n`;
    body += `explorer_api_requests_in_flight ${snapshot.inFlight}\n`;

    body += `# HELP explorer_api_self_check_runs_total Periodic self-check runs\n`;
    body += `# TYPE explorer_api_self_check_runs_total counter\n`;
    body += `explorer_api_self_check_runs_total ${snapshot.selfCheckRuns}\n`;

    body += `# HELP explorer_api_self_check_failures_total Periodic self-check failures\n`;
    body += `# TYPE explorer_api_self_check_failures_total counter\n`;
    body += `explorer_api_self_check_failures_total ${snapshot.selfCheckFailures}\n`;

    body += `# HELP explorer_api_self_check_last_ok Last self-check result\n`;
    body += `# TYPE explorer_api_self_check_last_ok gauge\n`;
    body += `explorer_api_self_check_last_ok ${snapshot.selfCheckLastOk === true ? 1 : 0}\n`;

    body += `# HELP explorer_api_self_check_last_at_ms Last self-check time (ms since epoch)\n`;
    body += `# TYPE explorer_api_self_check_last_at_ms gauge\n`;
    body += `explorer_api_self_check_last_at_ms ${snapshot.selfCheckLastAtMs ?? 0}\n`;

    body += `# HELP explorer_api_requests_by_path_total Requests per normalized path\n`;
    body += `# TYPE explorer_api_requests_by_path_total counter\n`;

    for (const [path, entry] of Object.entries(snapshot.byPath)) {
      const label = path.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      body += `explorer_api_requests_by_path_total{path="${label}"} ${entry.requests}\n`;
    }

    body += `# HELP explorer_api_request_errors_total 5xx responses per path\n`;
    body += `# TYPE explorer_api_request_errors_total counter\n`;

    for (const [path, entry] of Object.entries(snapshot.byPath)) {
      const label = path.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      body += `explorer_api_request_errors_total{path="${label}"} ${entry.errors}\n`;
    }

    body += `# HELP explorer_api_request_duration_ms_total Total request duration in ms per path\n`;
    body += `# TYPE explorer_api_request_duration_ms_total counter\n`;

    for (const [path, entry] of Object.entries(snapshot.byPath)) {
      const label = path.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      body += `explorer_api_request_duration_ms_total{path="${label}"} ${entry.totalMs}\n`;
    }

    body += `# HELP explorer_api_request_status_total HTTP status counts per path\n`;
    body += `# TYPE explorer_api_request_status_total counter\n`;

    for (const [path, entry] of Object.entries(snapshot.byPath)) {
      const pathLabel = path.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      for (const [status, count] of Object.entries(entry.statusCounts)) {
        body += `explorer_api_request_status_total{path="${pathLabel}",status="${status}"} ${count}\n`;
      }
    }

    res.status(200).type('text/plain; version=0.0.4').send(body);
  });

  const STATUS_CACHE_FRESH_MS = 2_000;
  const STATUS_CACHE_STALE_MAX_MS = 5 * 60_000;

  let statusCache:
    | { at: number; value: unknown }
    | null = null;

  let statusRefresh: Promise<{ at: number; value: unknown }> | null = null;

  async function fetchStatusPayload(): Promise<{ at: number; value: unknown }> {
    const at = Date.now();
    const status = await getDaemonStatus(env);

    const nowIso = new Date().toISOString();
    const currentHeight = status.daemon?.blocks ?? 0;
    const chainHeight = status.daemon?.headers ?? 0;
    const progress = chainHeight > 0 ? String(currentHeight / chainHeight) : '0';

    const payload = {
      ...status,
      indexer: {
        syncing: currentHeight < chainHeight,
        synced: currentHeight >= chainHeight,
        currentHeight,
        chainHeight,
        progress,
        lastSyncTime: nowIso,
        generatedAt: nowIso,
      },
    };

    return { at, value: payload };
  }

  function kickStatusRefresh(): Promise<{ at: number; value: unknown }> {
    if (statusRefresh) return statusRefresh;

    statusRefresh = fetchStatusPayload();

    statusRefresh
      .then((result) => {
        statusCache = result;
      })
      .catch(() => {})
      .finally(() => {
        statusRefresh = null;
      });

    return statusRefresh;
  }

  app.get('/api/v1/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=60');

    const now = Date.now();
    const cached = statusCache;

    if (cached && now - cached.at < STATUS_CACHE_STALE_MAX_MS) {
      if (now - cached.at >= STATUS_CACHE_FRESH_MS) {
        void kickStatusRefresh();
      }

      res.status(200).json(cached.value);
      return;
    }

    try {
      const result = await kickStatusRefresh();
      res.status(200).json(result.value);
    } catch (error) {
      if (cached) {
        res.status(200).json(cached.value);
        return;
      }

      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  const LATEST_BLOCKS_CACHE_FRESH_MS = 2_000;
  const LATEST_BLOCKS_CACHE_STALE_MAX_MS = 5 * 60_000;

  let latestBlocksCache = new Map<number, { at: number; value: unknown }>();
  let latestBlocksRefresh = new Map<number, Promise<void>>();

  async function refreshLatestBlocks(limit: number): Promise<void> {
    const response = await getLatestBlocks(env, limit);
    latestBlocksCache.set(limit, { at: Date.now(), value: response });
  }

  function kickLatestBlocksRefresh(limit: number): Promise<void> {
    const inflight = latestBlocksRefresh.get(limit);
    if (inflight) return inflight;

    const refresh = refreshLatestBlocks(limit)
      .catch(() => {})
      .finally(() => {
        latestBlocksRefresh.delete(limit);
      });

    latestBlocksRefresh.set(limit, refresh);
    return refresh;
  }

  app.get('/api/v1/blocks/latest', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=60');
 
    const now = Date.now();
    const limit = clampInt(toInt(req.query.limit) ?? 10, 1, 50);
 
    const cached = latestBlocksCache.get(limit);
    if (cached && now - cached.at < LATEST_BLOCKS_CACHE_STALE_MAX_MS) {
      if (now - cached.at >= LATEST_BLOCKS_CACHE_FRESH_MS) {
        void kickLatestBlocksRefresh(limit);
      }
 
      res.status(200).json(cached.value);
      return;
    }
 
    try {
      await kickLatestBlocksRefresh(limit);
      res.status(200).json(latestBlocksCache.get(limit)?.value);
    } catch (error) {
      if (cached) {
        res.status(200).json(cached.value);
        return;
      }
 
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  const HOME_SNAPSHOT_FRESH_MS = 250;

  let homeSnapshotCache: { at: number; value: unknown } | null = null;
  let homeSnapshotRefresh: Promise<void> | null = null;

  async function refreshHomeSnapshot(): Promise<void> {
    const tipHeight = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });
    const dashboard = dashboardStatsCache?.value;
    if (dashboard == null) {
      kickDashboardStatsRefresh(Date.now());
    }

    const existing = homeSnapshotCache?.value as any;
    if (existing?.tipHeight === tipHeight && Array.isArray(existing?.latestBlocks) && existing.latestBlocks.length > 0) {
      homeSnapshotCache = {
        at: Date.now(),
        value: {
          ...existing,
          dashboard: dashboard ?? null,
        },
      };
      return;
    }

    const blocksLatest = await getLatestBlocks(env, 6, tipHeight);

    const latestBlockFromBlocks = Array.isArray((blocksLatest as any)?.blocks)
      ? (blocksLatest as any).blocks[0]
      : null;

    const latestBlocks = Array.isArray((blocksLatest as any)?.blocks)
      ? (blocksLatest as any).blocks.map((block: any) => {
          const txCount = block.txCount ?? block.tx_count ?? block.txlength ?? 0;
          const nodeCount = block.nodeConfirmationCount ?? block.node_confirmation_count ?? 0;
          const regularTxCount = block.regularTxCount ?? block.regular_tx_count ?? Math.max(0, txCount - nodeCount);

          return {
            height: block.height,
            hash: block.hash,
            time: block.time ?? block.timestamp ?? 0,
            size: block.size ?? 0,
            txlength: txCount,
            nodeConfirmationCount: nodeCount,
            regularTxCount,
          };
        })
      : [];

    homeSnapshotCache = {
      at: Date.now(),
      value: {
        tipHeight: latestBlockFromBlocks?.height ?? (dashboard as any)?.latestBlock?.height ?? tipHeight,
        tipHash: latestBlockFromBlocks?.hash ?? (dashboard as any)?.latestBlock?.hash ?? null,
        tipTime: latestBlockFromBlocks?.time ?? (dashboard as any)?.latestBlock?.timestamp ?? null,
        latestBlocks,
        dashboard: dashboard ?? null,
      },
    };
  }

  function kickHomeSnapshotRefresh(): Promise<void> {
    if (homeSnapshotRefresh) return homeSnapshotRefresh;

    homeSnapshotRefresh = refreshHomeSnapshot().finally(() => {
      homeSnapshotRefresh = null;
    });

    return homeSnapshotRefresh;
  }

  app.get('/api/v1/home', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const now = Date.now();
    const cached = homeSnapshotCache;

    if (cached) {
      if (now - cached.at >= HOME_SNAPSHOT_FRESH_MS) {
        void kickHomeSnapshotRefresh().catch(() => {});
      }

      res.status(200).json(cached.value);
      return;
    }

    try {
      await kickHomeSnapshotRefresh();
      if (homeSnapshotCache?.value != null) {
        res.status(200).json(homeSnapshotCache.value);
        return;
      }

      res.setHeader('Retry-After', String(WARMUP_RETRY_AFTER_SECONDS));
      res.setHeader('x-upstream-degraded', '1');
      res.status(200).json(
        buildHomeWarmupPayload(
          now,
          statusCache?.value ?? null,
          dashboardStatsCache?.value ?? null,
          'home snapshot is warming up'
        )
      );
    } catch (error) {
      if (homeSnapshotCache?.value != null) {
        res.status(200).json(homeSnapshotCache.value);
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      const shouldDegrade = isStartupGracePeriod(now) || looksLikeWarmupError(message);
      if (shouldDegrade) {
        res.setHeader('Retry-After', String(WARMUP_RETRY_AFTER_SECONDS));
        res.setHeader('x-upstream-degraded', '1');
        res.status(200).json(
          buildHomeWarmupPayload(
            now,
            statusCache?.value ?? null,
            dashboardStatsCache?.value ?? null,
            `home snapshot unavailable: ${message}`
          )
        );
        return;
      }

      upstreamUnavailable(res, 'upstream_unavailable', message);
    }
  });

  app.get('/api/v1/blocks/range', async (req: Request, res: Response) => {
    try {
      const from = toInt(req.query.from);
      const to = toInt(req.query.to);
      if (from == null || to == null) {
        badRequest(res, 'invalid_request', 'from and to are required');
        return;
      }

      const start = Math.min(from, to);
      const end = Math.max(from, to);
      const range = end - start;
      if (range > 10_000) {
        badRequest(res, 'invalid_request', 'range too large');
        return;
      }

      if (range > 3000 && req.query.fields == null) {
        badRequest(res, 'invalid_request', 'fields is required for large ranges');
        return;
      }

      const response = await getBlocksRange(env, from, to);
      const fieldsRaw = req.query.fields != null ? String(req.query.fields) : null;
      if (!fieldsRaw) {
        res.status(200).json(response.blocks);
        return;
      }

      const fields = fieldsRaw
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0);

      const filtered = response.blocks.map((block) => {
        const out: Record<string, unknown> = {};
        for (const key of fields) {
          if (key in block) {
            out[key] = (block as Record<string, unknown>)[key];
          }
        }
        return out;
      });

      res.status(200).json(filtered);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/blocks/:hashOrHeight', async (req: Request, res: Response) => {
    try {
       const raw = String(req.query.raw ?? '').toLowerCase();
       if (raw === '1' || raw === 'true' || raw === 'yes') {
         const hashOrHeight = req.params.hashOrHeight;
         const height = toInt(hashOrHeight);
         const hash = height != null
           ? await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([height]) })
           : hashOrHeight;
         const rawblock = await fluxdGet<string>(env, 'getblock', { params: JSON.stringify([hash, 0]) });
         res.status(200).json({ rawblock });
         return;
       }


      const hashOrHeight = req.params.hashOrHeight;
      const height = toInt(hashOrHeight);

      const block = height != null ? await getBlockByHeight(env, height) : await getBlockByHash(env, hashOrHeight);
      res.status(200).json(block);
    } catch (error) {
      notFound(res, 'not_found', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/transactions/:txid', async (req: Request, res: Response) => {
    try {
      const txid = req.params.txid;
      const includeHex = String(req.query.includeHex ?? '').toLowerCase();
      const wantsHex = includeHex === '1' || includeHex === 'true' || includeHex === 'yes';
      const tx = await getTransaction(env, txid, wantsHex);
      res.status(200).json(tx);
    } catch (error) {
      notFound(res, 'not_found', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.post('/api/v1/transactions/batch', express.json(), async (req: Request, res: Response) => {
    try {
      const txids = Array.isArray(req.body?.txids) ? req.body.txids : [];
       if (txids.length === 0) {
         badRequest(res, 'invalid_request', 'txids is required');
         return;
       }


      const maxConcurrency = clampInt(toInt(req.query.concurrency) ?? 8, 1, 32);

      const ids = txids
        .map((id: unknown) => String(id))
        .filter((id: string) => isHexString(id, 64))
        .slice(0, 100);

       if (ids.length === 0) {
         badRequest(res, 'invalid_request', 'txids must be 64-char hex strings');
         return;
       }


      const transactions = new Array(ids.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(maxConcurrency, ids.length) }, async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= ids.length) return;

          const id = ids[idx];
          try {
            const tx = await getTransaction(env, id, false);
            transactions[idx] = tx;
          } catch (error) {
            transactions[idx] = {
              txid: id,
              error: 'not_found',
              message: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        }
      });

      await Promise.all(workers);

      res.status(200).json({ transactions });
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  const ADDRESS_SUMMARY_FRESH_MS = 15_000;
  const ADDRESS_SUMMARY_STALE_MAX_MS = 3 * 60_000;
  const addressSummaryCache = new Map<string, { at: number; value: unknown }>();
  const addressSummaryRefresh = new Map<string, Promise<void>>();

  async function refreshAddressSummary(address: string): Promise<void> {
    const response = await getAddressSummary(env, address);
    addressSummaryCache.set(address, { at: Date.now(), value: response });
  }

  function kickAddressSummaryRefresh(address: string): Promise<void> {
    const inflight = addressSummaryRefresh.get(address);
    if (inflight) return inflight;

    const refresh = refreshAddressSummary(address)
      .finally(() => {
        addressSummaryRefresh.delete(address);
      });

    addressSummaryRefresh.set(address, refresh);
    return refresh;
  }

  app.post('/api/v1/addresses/balances', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { addresses?: unknown; maxUtxos?: unknown };
      const addressesRaw = body.addresses;
      if (!Array.isArray(addressesRaw)) {
        badRequest(res, 'invalid_request', 'addresses must be an array');
        return;
      }

      const addresses = addressesRaw
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 60);

      if (addresses.length === 0) {
        badRequest(res, 'invalid_request', 'addresses must contain at least one entry');
        return;
      }

      const maxUtxos = clampInt(toInt(body.maxUtxos) ?? 100_000, 1, 500_000);

      const response = await getAddressBalances(env, addresses, { maxUtxos });
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=15, stale-while-revalidate=60');
      res.status(200).json(response);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/addresses/:address', async (req: Request, res: Response) => {
    const address = req.params.address;
    const now = Date.now();
    const cached = addressSummaryCache.get(address);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=15, stale-while-revalidate=180');

    if (cached && now - cached.at < ADDRESS_SUMMARY_STALE_MAX_MS) {
      if (now - cached.at >= ADDRESS_SUMMARY_FRESH_MS) {
        void kickAddressSummaryRefresh(address).catch(() => {});
      }
      res.status(200).json(cached.value);
      return;
    }

    try {
      await kickAddressSummaryRefresh(address);
      const latest = addressSummaryCache.get(address);
      if (latest) {
        res.status(200).json(latest.value);
        return;
      }

      throw new Error('Address summary unavailable');
    } catch (error) {
      if (cached) {
        res.status(200).json(cached.value);
        return;
      }

      notFound(res, 'not_found', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/addresses/:address/utxos', async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const response = await getAddressUtxos(env, address);
      res.status(200).json(response);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/addresses/:address/neighbors', async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const limit = clampInt(toInt(req.query.limit) ?? 50, 1, 200);
      const response = await getAddressNeighbors(env, address, { limit });
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json(response);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

   app.get('/api/v1/addresses/:address/transactions', async (req: Request, res: Response) => {
     try {
       const address = req.params.address;

       const limit = clampInt(toInt(req.query.limit) ?? 25, 1, 250);
       const offsetRaw = toInt(req.query.offset);
       const offset = offsetRaw != null ? Math.max(0, offsetRaw) : undefined;

       const cursorHeight = toInt(req.query.cursorHeight) ?? undefined;
       const cursorTxIndex = toInt(req.query.cursorTxIndex) ?? undefined;
       const cursorTxid = req.query.cursorTxid != null ? String(req.query.cursorTxid) : undefined;

       const fromBlock = toInt(req.query.fromBlock) ?? undefined;
       const toBlock = toInt(req.query.toBlock) ?? undefined;
       const fromTimestamp = toInt(req.query.fromTimestamp) ?? undefined;
       const toTimestamp = toInt(req.query.toTimestamp) ?? undefined;
       const excludeCoinbase = toBool(req.query.excludeCoinbase);
       const includeIo = req.query.includeIo == null ? true : toBool(req.query.includeIo);
       const skipTotals = toBool(req.query.skipTotals);

       // Always use getAddressTransactions for correct satoshi values
       const response = await getAddressTransactions(env, address, {
         limit,
         offset,
         cursorHeight,
         cursorTxIndex,
         cursorTxid,
         fromBlock,
         toBlock,
         fromTimestamp,
         toTimestamp,
         excludeCoinbase,
         includeIo,
         skipTotals,
       });

       res.status(200).json(response);
     } catch (error) {
       upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
     }
   });

  app.get('/api/v1/sync', async (_req: Request, res: Response) => {
    try {
      const status = await getDaemonStatus(env);
      const chainHeight = status.daemon?.headers ?? 0;
      const currentHeight = status.daemon?.blocks ?? 0;
      const percentage = chainHeight > 0 ? (currentHeight / chainHeight) * 100 : 0;

      res.status(200).json({
        indexer: {
          syncing: currentHeight < chainHeight,
          synced: currentHeight >= chainHeight,
          currentHeight,
          chainHeight,
          progress: chainHeight > 0 ? String(currentHeight / chainHeight) : '0',
          percentage,
          lastSyncTime: null,
        },
      });
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  let dashboardStatsCache: { at: number; value: unknown } | null = null;
  let dashboardStatsRefresh: Promise<void> | null = null;

  async function refreshDashboardStats(now: number): Promise<void> {
    try {
      const response = await getDashboardStats(env);
      dashboardStatsCache = { at: now, value: response };
    } catch {
    }
  }

  function kickDashboardStatsRefresh(now: number): void {
    if (dashboardStatsRefresh) return;
    dashboardStatsRefresh = refreshDashboardStats(now).finally(() => {
      dashboardStatsRefresh = null;
    });
  }

  const interval = setInterval(() => {
    kickDashboardStatsRefresh(Date.now());
  }, 2_000);

  if (env.fixturesMode) {
    clearInterval(interval);
  }

  app.get('/api/v1/stats/dashboard', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=60');
    const now = Date.now();
    const cached = dashboardStatsCache;

    if (cached && now - cached.at < 10 * 60_000) {
      if (now - cached.at >= 2_000) {
        kickDashboardStatsRefresh(now);
      }

      res.status(200).json(cached.value);
      return;
    }

    try {
      await refreshDashboardStats(now);
      res.status(200).json(dashboardStatsCache?.value);
    } catch (error) {
      if (cached) {
        res.status(200).json(cached.value);
        return;
      }
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/stats/index', async (_req: Request, res: Response) => {
    try {
      const response = await getIndexStats(env);
      res.status(200).json(response);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  app.get('/api/v1/estimatefee', async (req: Request, res: Response) => {
    try {
      const nbBlocks = toInt(req.query.nbBlocks) ?? 2;
      const response = await fluxdGet<number>(env, 'estimatefee', { params: JSON.stringify([nbBlocks]) });
      res.status(200).json(response);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  let supplyCache: { at: number; value: unknown } | null = null;
  let supplyRefresh: Promise<void> | null = null;

  async function refreshSupply(now: number): Promise<void> {
    const response = await getSupplyStats(env);
    supplyCache = { at: now, value: response };
  }

  app.get('/api/v1/supply', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    const now = Date.now();
    const cached = supplyCache;

    if (cached && now - cached.at < 10 * 60_000) {
      if (now - cached.at >= 15_000 && !supplyRefresh) {
        supplyRefresh = refreshSupply(now)
          .catch(() => {})
          .finally(() => {
            supplyRefresh = null;
          });
      }

      res.status(200).json(cached.value);
      return;
    }

    try {
      await refreshSupply(now);
      res.status(200).json(supplyCache?.value);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });


  let richListCache = new Map<string, { at: number; value: unknown }>();
  let richListRefresh = new Map<string, Promise<void>>();

  async function refreshRichList(key: string, page: number, pageSize: number, minBalance: number): Promise<void> {
    const response = await getRichList(env, page, pageSize, minBalance);
    richListCache.set(key, { at: Date.now(), value: response });
  }

  app.get('/api/v1/richlist', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    const now = Date.now();
    const page = clampInt(toInt(req.query.page) ?? 1, 1, 1000);
    const pageSize = clampInt(toInt(req.query.pageSize) ?? 100, 1, 1000);
    const minBalance = Math.max(0, toInt(req.query.minBalance) ?? 1);

    const key = `${page}:${pageSize}:${minBalance}`;
    const cached = richListCache.get(key);

    if (cached) {
      const ageMs = now - cached.at;
      const maxAgeMs = getRichListMaxAgeMs(cached.value);
      const refreshAfterMs = getRichListRefreshIntervalMs(cached.value);

      if (ageMs < maxAgeMs) {
        if (ageMs >= refreshAfterMs && !richListRefresh.get(key)) {
          const refresh = refreshRichList(key, page, pageSize, minBalance)
            .catch(() => {})
            .finally(() => {
              richListRefresh.delete(key);
            });
          richListRefresh.set(key, refresh);
        }

        res.status(200).json(cached.value);
        return;
      }
    }

    try {
      await refreshRichList(key, page, pageSize, minBalance);
      res.status(200).json(richListCache.get(key)?.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const cachedResponse = richListCache.get(key)?.value;
      if (cachedResponse) {
        res.status(200).json(cachedResponse);
        return;
      }

      if (isStartupGracePeriod(now) || looksLikeWarmupError(message)) {
        const statusValue = statusCache?.value as any;
        const lastBlockHeight =
          toInt(statusValue?.indexer?.currentHeight) ??
          toInt(statusValue?.daemon?.blocks) ??
          0;
        res.setHeader('Retry-After', String(WARMUP_RETRY_AFTER_SECONDS));
        res.setHeader('x-upstream-degraded', '1');
        res.status(200).json(
          buildRichListWarmupPayload(
            now,
            page,
            pageSize,
            minBalance,
            lastBlockHeight,
            `rich list unavailable: ${message}`
          )
        );
        return;
      }

      upstreamUnavailable(res, 'upstream_unavailable', message);
    }
  });


}
