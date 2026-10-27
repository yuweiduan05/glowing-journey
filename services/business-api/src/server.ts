/**
 * business-api 入口（:8082）
 * 独立启动：pnpm --filter @app/business-api dev
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './env.js';
import { openDatabase } from './db.js';
import { DDL } from './ddl.js';
import { isSeeded, seedDatabase } from './seed.js';
import { TicketService } from './domain/tickets.js';
import { registerRoutes } from './routes.js';
import { registerChaos } from './chaos.js';

// .env 已在 env.ts 模块顶层加载（先于 config 构造），此处无需再调 loadEnv()

const startedAt = Date.now();
mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = openDatabase(config.dbPath);
db.exec(DDL);

if (config.seedOnBoot && !isSeeded(db)) {
  seedDatabase(db);
  // eslint-disable-next-line no-console
  console.log('[business-api] 种子数据已写入（60 SKU / 3 仓 / 40 订单 / 12 工单）');
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
});

await app.register(cors, { origin: true });

registerChaos(app, config.chaosEnabled);
registerRoutes(app, {
  db,
  tickets: new TicketService(db, config.ticketRateLimit, config.ticketRateWindowMs),
  startedAt,
});

try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  // eslint-disable-next-line no-console
  console.log(`[business-api] http://127.0.0.1:${config.port}  db=${config.dbPath}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
