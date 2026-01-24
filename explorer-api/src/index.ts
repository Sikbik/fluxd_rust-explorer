import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { readEnv } from './env.js';
import { registerRoutes } from './routes.js';

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

const rateState = new Map<
  string,
  { tokens: number; lastRefillMs: number; blockedUntilMs: number; hits: number; penalties: number }
>();
const RATE_LIMIT_CAPACITY = 600;
const RATE_LIMIT_REFILL_PER_SEC = 10;
const RATE_LIMIT_BAN_MS = 2_000;
const RATE_LIMIT_STATE_TTL_MS = 10 * 60_000;
const ABUSE_PENALTY_THRESHOLD = 10;
const ABUSE_PENALTY_WINDOW_MS = 30_000;

const bannedIps = new Map<string, { untilMs: number; reason: string }>();
const BANLIST_ENTRY_TTL_MS = 60 * 60_000;

let lastSweptMs = Date.now();

function sweepMaps(now: number): void {
  for (const [key, value] of rateState) {
    if (now - value.lastRefillMs > RATE_LIMIT_STATE_TTL_MS) {
      rateState.delete(key);
    }
  }

  for (const [ip, ban] of bannedIps) {
    if (ban.untilMs <= now - BANLIST_ENTRY_TTL_MS) {
      bannedIps.delete(ip);
    }
  }
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

  const now = Date.now();
  if (now - lastSweptMs > 60_000) {
    lastSweptMs = now;
    sweepMaps(now);
  }

  const ip = req.ip ?? 'unknown';

  const ban = bannedIps.get(ip);
  if (ban && ban.untilMs > now) {
    res.status(429).json({ error: 'rate_limited' });
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
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
  const refill = elapsedSec * RATE_LIMIT_REFILL_PER_SEC;
  state.tokens = Math.min(RATE_LIMIT_CAPACITY, state.tokens + refill);
  state.lastRefillMs = now;

  if (state.tokens < 1) {
    state.blockedUntilMs = now + RATE_LIMIT_BAN_MS;
    state.penalties += 1;
    rateState.set(ip, state);

    if (state.penalties >= ABUSE_PENALTY_THRESHOLD) {
      bannedIps.set(ip, { untilMs: now + ABUSE_PENALTY_WINDOW_MS, reason: 'rate_limit' });
      state.penalties = 0;
      rateState.set(ip, state);
    }

    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  state.tokens -= 1;
  state.hits += 1;
  rateState.set(ip, state);

  next();
});

registerRoutes(app, env);

app.listen(env.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`explorer-api listening on 0.0.0.0:${env.port}`);

  fetch(`http://127.0.0.1:${env.port}/api/v1/supply`).catch(() => undefined);
  fetch(`http://127.0.0.1:${env.port}/api/v1/blocks/latest?limit=6`).catch(() => undefined);
  fetch(`http://127.0.0.1:${env.port}/api/v1/richlist?page=1&pageSize=100&minBalance=1`).catch(() => undefined);

  setInterval(() => {
    fetch(`http://127.0.0.1:${env.port}/api/v1/supply`).catch(() => undefined);
    fetch(`http://127.0.0.1:${env.port}/api/v1/blocks/latest?limit=6`).catch(() => undefined);
    fetch(`http://127.0.0.1:${env.port}/api/v1/richlist?page=1&pageSize=100&minBalance=1`).catch(() => undefined);
  }, 60_000);
});
