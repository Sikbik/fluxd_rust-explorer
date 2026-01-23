import express from 'express';
import type { Express } from 'express';
import { readEnv } from './env.js';
import { registerRoutes } from './routes.js';

const app: Express = express();
app.disable('x-powered-by');

const env = readEnv();
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
