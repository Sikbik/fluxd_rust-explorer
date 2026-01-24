import express, { type Express, type Request, type Response } from 'express';
import type { Env } from './env.js';
import { getDaemonStatus } from './fluxd-rpc.js';
import {
  getAddressSummary,
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
    if (path.endsWith('/transactions')) return '/api/v1/addresses/:address/transactions';
    if (path.endsWith('/utxos')) return '/api/v1/addresses/:address/utxos';
    return '/api/v1/addresses/:address';
  }

  return path;
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

  let statusCache:
    | { at: number; value: unknown }
    | null = null;

  app.get('/api/v1/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=10');
    try {
      const now = Date.now();
      const cached = statusCache;
      if (cached && now - cached.at < 2000) {
        res.status(200).json(cached.value);
        return;
      }

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

      statusCache = { at: now, value: payload };
      res.status(200).json(payload);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  let latestBlocksCache: { at: number; limit: number; value: unknown } | null = null;

   app.get('/api/v1/blocks/latest', async (req: Request, res: Response) => {
     const now = Date.now();
     const limit = clampInt(toInt(req.query.limit) ?? 10, 1, 50);


    const cached = latestBlocksCache;
    if (cached && cached.limit === limit && now - cached.at < 15_000) {
      res.status(200).json(cached.value);
      return;
    }

    try {
      const response = await getLatestBlocks(env, limit);
      latestBlocksCache = { at: now, limit, value: response };
      res.status(200).json(response);
    } catch (error) {
      if (cached && cached.limit === limit && now - cached.at < 10 * 60_000) {
        res.status(200).json(cached.value);
        return;
      }

      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
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

  app.get('/api/v1/addresses/:address', async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const response = await getAddressSummary(env, address);
      res.status(200).json(response);
    } catch (error) {
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

  app.get('/api/v1/addresses/:address/transactions', async (req: Request, res: Response) => {
    try {
      const address = req.params.address;

      const limit = clampInt(toInt(req.query.limit) ?? 25, 1, 100);
      const offsetRaw = toInt(req.query.offset);
      const offset = offsetRaw != null ? Math.max(0, offsetRaw) : undefined;

      const cursorHeight = toInt(req.query.cursorHeight) ?? undefined;
      const cursorTxIndex = toInt(req.query.cursorTxIndex) ?? undefined;
      const cursorTxid = req.query.cursorTxid != null ? String(req.query.cursorTxid) : undefined;

      const fromBlock = toInt(req.query.fromBlock) ?? undefined;
      const toBlock = toInt(req.query.toBlock) ?? undefined;
      const fromTimestamp = toInt(req.query.fromTimestamp) ?? undefined;
      const toTimestamp = toInt(req.query.toTimestamp) ?? undefined;

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

  app.get('/api/v1/stats/dashboard', async (_req: Request, res: Response) => {
    try {
      const response = await getDashboardStats(env);
      res.status(200).json(response);
    } catch (error) {
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
        supplyRefresh = refreshSupply(now).finally(() => {
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

  async function refreshRichList(key: string, now: number, page: number, pageSize: number, minBalance: number): Promise<void> {
    const response = await getRichList(env, page, pageSize, minBalance);
    richListCache.set(key, { at: now, value: response });
  }

  app.get('/api/v1/richlist', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    const now = Date.now();
      const page = clampInt(toInt(req.query.page) ?? 1, 1, 1000);
      const pageSize = clampInt(toInt(req.query.pageSize) ?? 100, 1, 1000);
      const minBalance = Math.max(0, toInt(req.query.minBalance) ?? 1);



    const key = `${page}:${pageSize}:${minBalance}`;
    const cached = richListCache.get(key);

    if (cached && now - cached.at < 10 * 60_000) {
      if (now - cached.at >= 60_000 && !richListRefresh.get(key)) {
        const refresh = refreshRichList(key, now, page, pageSize, minBalance).finally(() => {
          richListRefresh.delete(key);
        });
        richListRefresh.set(key, refresh);
      }

      res.status(200).json(cached.value);
      return;
    }

    try {
      await refreshRichList(key, now, page, pageSize, minBalance);
      res.status(200).json(richListCache.get(key)?.value);
    } catch (error) {
      upstreamUnavailable(res, 'upstream_unavailable', error instanceof Error ? error.message : 'Unknown error');
    }
  });


}

