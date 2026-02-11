import test from 'node:test';
import assert from 'node:assert/strict';

import { registerRoutes } from '../routes.js';

test('contract: registers core api/v1 routes', async () => {
  const registered: Array<{ method: string; path: string }> = [];

  const app = {
    use: (_path: string, _handler: unknown) => {
      registered.push({ method: 'USE', path: _path });
    },
    get: (path: string, _handler: unknown) => {
      registered.push({ method: 'GET', path });
    },
    post: (path: string, _handler: unknown) => {
      registered.push({ method: 'POST', path });
    },
  };

  registerRoutes(app as never, {
    port: 0,
    fluxdRpcUrl: 'http://fluxd:16124',
    rpcAuthMode: 'none',
    fixturesMode: true,
    rateLimit: {
      capacity: 240,
      refillPerSec: 8,
      stateTtlMs: 10 * 60_000,
      defaultPolicy: {
        cost: 1,
        concurrentLimit: 24,
        blockMs: 2_000,
        penaltyThreshold: 12,
        penaltyWindowMs: 45_000,
      },
      heavyPolicy: {
        cost: 8,
        concurrentLimit: 2,
        blockMs: 3_000,
        penaltyThreshold: 6,
        penaltyWindowMs: 60_000,
      },
      veryHeavyPolicy: {
        cost: 12,
        concurrentLimit: 1,
        blockMs: 5_000,
        penaltyThreshold: 5,
        penaltyWindowMs: 90_000,
      },
      richListCost: 6,
      richListConcurrentLimit: 2,
    },
  });

  const expected = [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/ready' },
    { method: 'GET', path: '/metrics' },

    { method: 'GET', path: '/api/v1/status' },
    { method: 'GET', path: '/api/v1/sync' },
    { method: 'GET', path: '/api/v1/blocks/latest' },
    { method: 'GET', path: '/api/v1/blocks/range' },
    { method: 'GET', path: '/api/v1/blocks/:hashOrHeight' },
    { method: 'GET', path: '/api/v1/transactions/:txid' },
    { method: 'POST', path: '/api/v1/transactions/batch' },
    { method: 'GET', path: '/api/v1/addresses/:address' },
    { method: 'GET', path: '/api/v1/addresses/:address/utxos' },
    { method: 'GET', path: '/api/v1/addresses/:address/transactions' },
    { method: 'GET', path: '/api/v1/sync' },
    { method: 'GET', path: '/api/v1/stats/dashboard' },
    { method: 'GET', path: '/api/v1/stats/index' },
    { method: 'GET', path: '/api/v1/estimatefee' },
    { method: 'GET', path: '/api/v1/supply' },
    { method: 'GET', path: '/api/v1/richlist' },
    { method: 'GET', path: '/api/v1/home' },
  ];

  for (const route of expected) {
    assert.ok(
      registered.some((r) => r.method === route.method && r.path === route.path),
      `missing route: ${route.method} ${route.path}`
    );
  }
});
