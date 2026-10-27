/**
 * HTTP 路由（internal 服务，仅供网关调用）
 *
 * 成功响应直接返回业务对象；错误统一走 { code, message, request_id, details? } 信封。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  AppError,
  CreateTicketInputSchema,
  QueryInventoryInputSchema,
  QueryOrderInputSchema,
  normalizeError,
} from '@app/shared';
import type { Database } from './db.js';
import { queryInventory } from './domain/inventory.js';
import { queryOrder } from './domain/orders.js';
import { TicketService } from './domain/tickets.js';

export interface RouteContext {
  db: Database;
  tickets: TicketService;
  startedAt: number;
}

function customerFrom(req: FastifyRequest): string {
  const raw = req.headers['x-customer-id'];
  const customerId = Array.isArray(raw) ? raw[0] : raw;
  if (!customerId) {
    throw new AppError('UNAUTHORIZED', {
      message: '缺少 X-Customer-Id（应由网关鉴权后注入，业务服务不对外暴露）',
    });
  }
  return String(customerId);
}

function zodToAppError(err: ZodError): AppError {
  return new AppError('INVALID_ARGUMENT', {
    message: '请求参数不符合 Schema',
    details: err.issues.map((i) => ({
      path: '/' + i.path.join('/'),
      message: i.message,
      code: i.code,
    })),
  });
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.setErrorHandler((err, req, reply) => {
    const appErr = err instanceof ZodError ? zodToAppError(err) : normalizeError(err);
    req.log.warn(
      {
        request_id: String(req.id),
        conversation_id: req.headers['x-conversation-id'] ?? null,
        code: appErr.code,
        msg: appErr.message,
      },
      'request failed',
    );
    void reply.status(appErr.httpStatus).send(appErr.toEnvelope(String(req.id)));
  });

  // 追踪：request_id 由网关透传（缺省自生成），conversation_id 一并落日志，
  // 这样一次对话在 gateway / business-api / rag 三处日志能用同一组 id 串起来。
  app.addHook('onRequest', async (req) => {
    if (!req.headers['x-request-id']) req.headers['x-request-id'] = randomUUID();
    const rawConversation = req.headers['x-conversation-id'];
    const conversationId = Array.isArray(rawConversation) ? rawConversation[0] : rawConversation;
    req.log.info(
      {
        request_id: String(req.id),
        conversation_id: conversationId ? String(conversationId) : null,
      },
      'request received',
    );
  });

  app.get('/health', async () => {
    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number };
    const tickets = ctx.db.prepare('SELECT COUNT(*) AS c FROM tickets').get() as { c: number };
    return {
      status: 'ok',
      service: 'business-api',
      version: '0.1.0',
      ts: Date.now(),
      uptime_s: Math.round((Date.now() - ctx.startedAt) / 1000),
      checks: {
        sqlite: { status: 'ok', detail: `products=${row.c}` },
        tickets: { status: 'ok', detail: `tickets=${tickets.c}` },
      },
    };
  });

  /** T1 的后端实现 */
  app.get('/v1/inventory/:sku', async (req) => {
    const { sku } = req.params as { sku: string };
    const q = req.query as Record<string, string | undefined>;
    const input = QueryInventoryInputSchema.parse({
      sku,
      warehouse_code: q.warehouse_code || undefined,
      include_reserved: q.include_reserved === undefined ? undefined : q.include_reserved !== 'false',
    });
    return queryInventory(ctx.db, input);
  });

  /** 补充查询：低于安全库存的 SKU（2.2 库存语义，供看板与人工排查使用） */
  app.get('/v1/inventory', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const rows = ctx.db
      .prepare(
        `SELECT p.sku, p.name, p.safety_stock,
                SUM(s.on_hand) AS on_hand,
                SUM(s.reserved) AS reserved,
                SUM(MAX(s.on_hand - s.reserved, 0)) AS available
           FROM products p JOIN stock s ON s.sku = p.sku
          GROUP BY p.sku, p.name, p.safety_stock
         HAVING available < p.safety_stock
          ORDER BY (p.safety_stock - available) DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Record<string, number | string>>;
    return { count: rows.length, items: rows };
  });

  /** T2 的后端实现 */
  app.get('/v1/orders/:orderNo', async (req) => {
    const customerId = customerFrom(req);
    const { orderNo } = req.params as { orderNo: string };
    const input = QueryOrderInputSchema.parse({ order_no: orderNo });
    return queryOrder(ctx.db, input, customerId);
  });

  app.get('/v1/orders', async (req) => {
    const customerId = customerFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const input = QueryOrderInputSchema.parse({ phone_tail: q.phone_tail });
    return queryOrder(ctx.db, input, customerId);
  });

  /** T3 的后端实现 */
  app.post('/v1/tickets', async (req, reply: FastifyReply) => {
    const customerId = customerFrom(req);
    const input = CreateTicketInputSchema.parse(req.body);
    const result = ctx.tickets.create(input, customerId);
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.get('/v1/tickets/:ticketNo', async (req, reply) => {
    // 与订单路径一致：customer_id 只来自网关注入的 X-Customer-Id，越权 403
    const customerId = customerFrom(req);
    const { ticketNo } = req.params as { ticketNo: string };
    return reply.send(ctx.tickets.get(ticketNo, customerId));
  });
}
