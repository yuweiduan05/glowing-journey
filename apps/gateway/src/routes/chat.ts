/**
 * /v1/chat/completions（OpenAI 兼容外形 + 本项目的流式事件协议）
 *
 * 流式：HTTP 200 + SSE（9 类事件）；开流之后的错误一律走 error 事件。
 * 非流式：HTTP 状态码 + { code, message, request_id, details? } 信封。
 */
import { randomUUID } from 'node:crypto';
import { AppError, ChatRequestSchema, normalizeError, type ChatCompletionResponse } from '@app/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ModelChain, ChainName } from '../chain.js';
import type { ToolRegistry } from '../tools/registry.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { resolveCaller } from '../auth.js';
import { config } from '../env.js';
import { SseWriter } from '../sse.js';

export interface ChatRouteDeps {
  chain: ModelChain;
  registry: ToolRegistry;
  modelLabel: string;
}

function resolveChain(req: FastifyRequest): ChainName {
  const raw = String(req.headers['x-chain'] ?? 'proxy').toLowerCase();
  if (raw !== 'direct' && raw !== 'proxy') {
    throw new AppError('INVALID_ARGUMENT', {
      message: `X-Chain 只能是 direct 或 proxy，收到 ${raw}`,
      details: [{ path: '/X-Chain', message: '非法链路标识', code: 'invalid_enum' }],
    });
  }
  return raw;
}

function resolveConversationId(req: FastifyRequest, bodyId?: string): string {
  const header = req.headers['x-conversation-id'];
  const id = (Array.isArray(header) ? header[0] : header) ?? bodyId ?? randomUUID();
  return String(id).slice(0, 64);
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('INVALID_ARGUMENT', {
        message: '请求体不符合 Schema',
        details: parsed.error.issues.map((i) => ({
          path: '/' + i.path.join('/'),
          message: i.message,
          code: i.code,
        })),
      });
    }

    const body = parsed.data;
    const caller = resolveCaller(req);
    const chainName = resolveChain(req);
    const conversationId = resolveConversationId(req, body.conversation_id);
    const requestId = String(req.id);
    const startedAt = Date.now();
    const chaosRaw = (req.query as Record<string, string | undefined> | undefined)?.chaos;
    const chaos = typeof chaosRaw === 'string' ? chaosRaw : undefined;

    if (!body.stream) {
      let text = '';
      let reasoning = '';
      const citations: ChatCompletionResponse['citations'] = [];
      const timeline: NonNullable<ChatCompletionResponse['timeline']> = [];
      let boundary: ChatCompletionResponse['boundary'];
      const orchestrator = new AgentOrchestrator(deps.chain, deps.registry);
      const result = await orchestrator.run(body.messages, {
        requestId,
        conversationId,
        customerId: caller.customerId,
        chain: chainName,
        enableKnowledge: body.enable_knowledge,
        maxToolRounds: body.max_tool_rounds,
        temperature: body.temperature,
        chaos,
        signal: AbortSignal.timeout(120_000),
        emit: (msg) => {
          if (msg.event === 'token') text += msg.data.delta;
          if (msg.event === 'reasoning') reasoning += msg.data.delta;
          if (msg.event === 'citation') citations.push(...(msg.data.sources as typeof citations));
          // 非流式也保留完整时间线：thought/tool_call/tool_result 与流式等价
          if (msg.event === 'thought') {
            timeline.push({ kind: 'thought', step: msg.data.step, text: msg.data.text });
          }
          if (msg.event === 'tool_call') {
            timeline.push({
              kind: 'tool',
              call_id: msg.data.call_id,
              name: msg.data.name,
              args: msg.data.args,
              status: 'ok',
              latency_ms: 0,
            });
          }
          if (msg.event === 'tool_result') {
            const item = timeline.find((t) => t.kind === 'tool' && t.call_id === msg.data.call_id);
            if (item && item.kind === 'tool') {
              item.status = msg.data.status;
              item.latency_ms = msg.data.latency_ms;
              item.data = msg.data.data;
              item.error = msg.data.error;
            }
          }
        },
        logger: req.log,
      });
      boundary = result.boundary;

      const response: ChatCompletionResponse = {
        id: `chatcmpl_${requestId}`,
        object: 'chat.completion',
        created: Math.floor(startedAt / 1000),
        model: deps.modelLabel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text || text },
            finish_reason: result.finishReason,
          },
        ],
        usage: result.usage,
        request_id: requestId,
      };
      if (citations.length) response.citations = citations;
      if (boundary) response.boundary = boundary;
      if (reasoning) response.reasoning = reasoning;
      if (timeline.length) response.timeline = timeline;
      return reply.send(response);
    }

    // ---- 流式 ----
    reply.hijack();
    const origin = req.headers.origin;
    if (origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    const writer = new SseWriter(reply.raw, config.heartbeatMs);
    writer.send('meta', {
      request_id: requestId,
      chain: chainName,
      model: deps.modelLabel,
      mode: 'stream',
      ts: Date.now(),
    });

    const orchestrator = new AgentOrchestrator(deps.chain, deps.registry);

    try {
      const result = await orchestrator.run(body.messages, {
        requestId,
        conversationId,
        customerId: caller.customerId,
        chain: chainName,
        enableKnowledge: body.enable_knowledge,
        maxToolRounds: body.max_tool_rounds,
        temperature: body.temperature,
        chaos,
        signal: writer.signal,
        emit: (msg) => writer.send(msg.event, msg.data),
        logger: req.log,
      });

      if (writer.isClosed) return;

      writer.send('done', {
        finish_reason: result.finishReason,
        usage: result.usage,
        total_ms: Date.now() - startedAt,
      });
      writer.end();
    } catch (err) {
      const appErr = normalizeError(err);
      if (writer.isClosed) return;
      req.log.error({ code: appErr.code, msg: appErr.message }, 'chat failed');
      writer.send('error', {
        code: appErr.code,
        message: appErr.message,
        retryable: appErr.retryable,
        details: appErr.details,
      });
      writer.end();
    }
  });
}
