/**
 * 工具注册表执行层（对应 1.2「工具健壮：参数校验、异常处理、幂等/边界齐全」）
 *
 * 这一层只做四件事，业务规则全部在 business-api：
 *   1. 参数校验（zod，422 + 字段级 details）；
 *   2. 服务端字段注入（customer_id / idempotency_key，模型不可见）；
 *   3. HTTP 调用与超时；
 *   4. 错误翻译（下游错误 → 统一错误码，ADR-005）。
 */
import { createHash } from 'node:crypto';
import {
  AppError,
  CreateTicketInputSchema,
  ERROR_CODES,
  TOOL_BY_NAME,
  isToolName,
  type ErrorCode,
  type ErrorDetail,
  type ToolName,
} from '@app/shared';

export interface ToolCallContext {
  customerId: string;
  conversationId: string;
  /** 网关请求 id，透传给下游用于跨服务日志串联 */
  requestId?: string;
  /** 演示用故障注入透传：?chaos=slow|fail|500 会附加到 business-api 请求 */
  chaos?: string;
  /** proxy 链路对读工具做一次重试；direct 不重试 */
  retryRead?: boolean;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  callId: string;
  name: ToolName;
  status: 'ok' | 'error';
  latencyMs: number;
  data?: unknown;
  error?: { code: ErrorCode; message: string; details?: ErrorDetail[] };
}

export interface ToolRegistryOptions {
  businessBaseUrl: string;
  ragBaseUrl: string;
  toolTimeoutMs: number;
  ragTimeoutMs: number;
}

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

/** 摘要归一化：去掉空白与标点，避免「同一句话换个标点」被当成两次操作 */
function normalizeSummary(summary: unknown): string {
  return String(summary ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）()【】\[\]!?,.;:]/g, '')
    .toLowerCase();
}

/**
 * 幂等键派生：同一会话 + 同一订单 + 同一类别 + **同一问题摘要** → 同一 key。
 *
 * 为什么要加摘要指纹：只用 (会话, 订单, 类别) 时，客户在同一会话里先报「少发」、
 * 再报「外箱破损」，两条都会被归到 LOGISTICS 而折叠成一张工单 —— 幂等的本意是
 * 「同一次操作重放不重复生效」，不是「同类问题去重」，后者会漏单。
 *
 * 若交给模型生成 uuid，每次重放都会是新 key，幂等必然失效，所以必须服务端派生。
 */
export function deriveIdempotencyKey(conversationId: string, args: Record<string, unknown>): string {
  const summaryFingerprint = createHash('sha256')
    .update(normalizeSummary(args.summary))
    .digest('hex')
    .slice(0, 12);
  const basis = [
    conversationId,
    String(args.order_no ?? ''),
    String(args.category ?? ''),
    summaryFingerprint,
  ].join('|');
  const h = createHash('sha256').update(basis).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class ToolRegistry {
  constructor(private readonly opts: ToolRegistryOptions) {}

  async execute(name: string, rawArgs: string, callId: string, ctx: ToolCallContext): Promise<ToolOutcome> {
    const startedAt = Date.now();

    const fail = (error: AppError): ToolOutcome => ({
      callId,
      name: name as ToolName,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: { code: error.code, message: error.message, details: error.details },
    });

    if (!isToolName(name)) {
      return fail(new AppError('INVALID_ARGUMENT', { message: `未注册的工具：${name}` }));
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return fail(
        new AppError('TOOL_ARGS_INVALID', {
          message: '工具参数不是合法 JSON',
          details: [{ path: '/', message: 'JSON 解析失败', code: 'invalid_json' }],
        }),
      );
    }

    const def = TOOL_BY_NAME[name];
    const checked = def.modelInputSchema.safeParse(parsedArgs);
    if (!checked.success) {
      return fail(
        new AppError('TOOL_ARGS_INVALID', {
          message: '模型生成的工具参数不符合 Schema',
          details: checked.error.issues.map((i) => ({
            path: '/' + i.path.join('/'),
            message: i.message,
            code: i.code,
          })),
        }),
      );
    }

    // 服务端注入（模型不可传，传了会被上面 strict schema 拒绝）
    const args: Record<string, unknown> = { ...(checked.data as Record<string, unknown>) };
    if (name === 'create_ticket') {
      args.idempotency_key = deriveIdempotencyKey(ctx.conversationId, args);
      const full = CreateTicketInputSchema.safeParse(args);
      if (!full.success) {
        return fail(
          new AppError('TOOL_ARGS_INVALID', {
            message: '工单参数校验失败',
            details: full.error.issues.map((i) => ({
              path: '/' + i.path.join('/'),
              message: i.message,
              code: i.code,
            })),
          }),
        );
      }
      Object.assign(args, full.data);
    }

    const maxAttempts = ctx.retryRead && def.kind === 'read' ? 2 : 1;
    let lastError: AppError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const data = await this.dispatch(name, args, ctx);

        const out = def.outputSchema.safeParse(data);
        if (!out.success) {
          return {
            callId,
            name,
            status: 'error',
            latencyMs: Date.now() - startedAt,
            error: {
              code: 'TOOL_UPSTREAM_ERROR',
              message: '下游返回结构不符合工具契约',
              details: out.error.issues.map((i) => ({
                path: '/' + i.path.join('/'),
                message: i.message,
              })),
            },
          };
        }

        return {
          callId,
          name,
          status: 'ok',
          latencyMs: Date.now() - startedAt,
          data: out.data,
        };
      } catch (err) {
        lastError = err instanceof AppError ? err : new AppError('INTERNAL_ERROR', { message: String(err) });
        // 只对可重试的读工具做一次退避重试（写工具靠幂等键，不盲目重试）
        if (attempt < maxAttempts && lastError.retryable) {
          await new Promise((r) => setTimeout(r, 200 * attempt));
          continue;
        }
        break;
      }
    }

    return fail(lastError ?? new AppError('INTERNAL_ERROR', { message: '工具调用失败' }));
  }

  private dispatch(name: ToolName, args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown> {
    switch (name) {
      case 'query_inventory':
        return this.getInventory(args, ctx);
      case 'query_order':
        return this.getOrder(args, ctx);
      case 'create_ticket':
        return this.createTicket(args, ctx);
      case 'search_knowledge':
        return this.searchKnowledge(args, ctx);
    }
  }

  /** 跨服务追踪头：下游日志用同一组 id，排查时能串起来 */
  private traceHeaders(ctx: ToolCallContext): Record<string, string> {
    return {
      ...(ctx.requestId ? { 'X-Request-Id': ctx.requestId } : {}),
      ...(ctx.conversationId ? { 'X-Conversation-Id': ctx.conversationId } : {}),
    };
  }

  /** 演示用故障注入透传：网关 ?chaos=500 → business-api ?chaos=500 */
  private withChaos(url: string, ctx: ToolCallContext): string {
    if (!ctx.chaos) return url;
    return `${url}${url.includes('?') ? '&' : '?'}chaos=${encodeURIComponent(ctx.chaos)}`;
  }

  private async getInventory(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown> {
    const qs = new URLSearchParams();
    if (args.warehouse_code) qs.set('warehouse_code', String(args.warehouse_code));
    if (args.include_reserved !== undefined) qs.set('include_reserved', String(args.include_reserved));
    const url = this.withChaos(`${this.opts.businessBaseUrl}/v1/inventory/${encodeURIComponent(String(args.sku))}?${qs}`, ctx);
    return this.request(
      url,
      { method: 'GET', headers: { ...this.traceHeaders(ctx) } },
      this.opts.toolTimeoutMs,
      ctx,
      'TOOL_UPSTREAM_ERROR',
    );
  }

  private async getOrder(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown> {
    const url = args.order_no
      ? `${this.opts.businessBaseUrl}/v1/orders/${encodeURIComponent(String(args.order_no))}`
      : `${this.opts.businessBaseUrl}/v1/orders?phone_tail=${encodeURIComponent(String(args.phone_tail))}`;
    return this.request(
      this.withChaos(url, ctx),
      { method: 'GET', headers: { 'X-Customer-Id': ctx.customerId, ...this.traceHeaders(ctx) } },
      this.opts.toolTimeoutMs,
      ctx,
      'TOOL_UPSTREAM_ERROR',
    );
  }

  private async createTicket(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown> {
    return this.request(
      this.withChaos(`${this.opts.businessBaseUrl}/v1/tickets`, ctx),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Customer-Id': ctx.customerId,
          ...this.traceHeaders(ctx),
        },
        body: JSON.stringify(args),
      },
      this.opts.toolTimeoutMs,
      ctx,
      'TOOL_UPSTREAM_ERROR',
    );
  }

  private async searchKnowledge(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown> {
    return this.request(
      `${this.opts.ragBaseUrl}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.traceHeaders(ctx) },
        body: JSON.stringify({
          question: args.question,
          top_k: args.top_k ?? 4,
          filters: args.filters ?? {},
          conversation_id: ctx.conversationId,
        }),
      },
      this.opts.ragTimeoutMs,
      ctx,
      'RAG_UNAVAILABLE',
    );
  }

  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    ctx: ToolCallContext,
    fallbackCode: ErrorCode,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (timeout.aborted) {
        throw new AppError('TOOL_TIMEOUT', {
          message: `工具调用超时（>${timeoutMs}ms）`,
          cause: err,
        });
      }
      throw new AppError(fallbackCode, {
        message: `下游服务不可达：${(err as Error).message}`,
        cause: err,
      });
    }

    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      const env = (body ?? {}) as { code?: unknown; message?: unknown; details?: ErrorDetail[] };
      if (isErrorCode(env.code)) {
        // 下游自报 INTERNAL_ERROR 属于「工具上游故障」，翻译成 TOOL_UPSTREAM_ERROR，
        // 避免与网关自身 500 混淆（前端据此展示「业务服务异常」而不是「系统崩了」）
        const code = env.code === 'INTERNAL_ERROR' ? fallbackCode : env.code;
        throw new AppError(code, {
          message: typeof env.message === 'string' ? env.message : `下游返回 ${res.status}`,
          details: env.details,
        });
      }
      if (res.status === 404) throw new AppError('NOT_FOUND', { message: '下游资源不存在' });
      if (res.status === 403) throw new AppError('FORBIDDEN_DATA_SCOPE', { message: '越权访问被拒绝' });
      if (res.status === 429) throw new AppError('RATE_LIMITED', { message: '下游限流' });
      throw new AppError(fallbackCode, { message: `下游返回 ${res.status}：${text.slice(0, 200)}` });
    }

    return body;
  }
}
