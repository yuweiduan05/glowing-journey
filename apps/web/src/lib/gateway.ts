/**
 * 网关客户端：SSE 解析复用 @app/shared 的 SseParser（与网关同源实现，避免两套解析器漂移）
 */
import { SseParser, type Boundary, type SseMessage } from '@app/shared';

export const GATEWAY_BASE = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://127.0.0.1:8081';

export type Chain = 'direct' | 'proxy';

export interface WireMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TimelineThought {
  kind: 'thought';
  step: string;
  text: string;
  ts: number;
}

export interface TimelineTool {
  kind: 'tool';
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  latencyMs?: number;
  data?: unknown;
  error?: { code: string; message: string; details?: Array<{ path: string; message: string }> };
}

export type TimelineItem = TimelineThought | TimelineTool;

export interface Citation {
  doc_id?: string;
  doc_title: string;
  section: string;
  chunk_id: string;
  score: number;
  text?: string;
}

export interface SendOptions {
  messages: WireMessage[];
  chain: Chain;
  stream: boolean;
  enableKnowledge: boolean;
  chaos?: string;
  signal: AbortSignal;
  conversationId: string;
  handlers: {
    onMeta?: (meta: { request_id: string; model: string; chain: Chain }) => void;
    onThought?: (t: TimelineThought) => void;
    /** 模型思考增量：累积成字符串，正文首 token 到达后折叠 */
    onReasoning?: (delta: string) => void;
    onToolCall?: (t: TimelineTool) => void;
    onToolResult?: (callId: string, patch: Partial<TimelineTool>) => void;
    onToken?: (delta: string) => void;
    onCitation?: (sources: Citation[]) => void;
    onHandoff?: (reason: string) => void;
    /** 结构化边界（in_kb / insufficient / out_of_scope）；流式与非流式都会回调 */
    onBoundary?: (boundary: Boundary) => void;
    onDone?: (info: { finish_reason: string; total_ms: number; usage?: unknown }) => void;
    onError?: (err: { code: string; message: string; retryable: boolean }) => void;
  };
}

function headers(conversationId: string, chain: Chain) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer demo-token',
    'X-Chain': chain,
    'X-Conversation-Id': conversationId,
  };
}

export async function sendChat(opts: SendOptions): Promise<void> {
  const url = `${GATEWAY_BASE}/v1/chat/completions${opts.chaos ? `?chaos=${encodeURIComponent(opts.chaos)}` : ''}`;
  const body = JSON.stringify({
    messages: opts.messages,
    stream: opts.stream,
    conversation_id: opts.conversationId,
    enable_knowledge: opts.enableKnowledge,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(opts.conversationId, opts.chain),
    body,
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const env = (await res.json()) as { code?: string; message?: string };
      detail = `${env.code ?? res.status}：${env.message ?? detail}`;
    } catch {
      /* 忽略非 JSON 错误体 */
    }
    throw new Error(detail);
  }

  // 非流式：一次性返回，合成等价事件（含时间线——关掉流式开关不丢可解释性）
  if (!opts.stream) {
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      citations?: Array<{ doc_title: string; section: string; chunk_id: string; score: number; doc_id?: string; text?: string }>;
      boundary?: string;
      reasoning?: string;
      timeline?: Array<
        | { kind: 'thought'; step: string; text: string }
        | {
            kind: 'tool';
            call_id: string;
            name: string;
            args: Record<string, unknown>;
            status: 'ok' | 'error';
            latency_ms: number;
            data?: unknown;
            error?: { code: string; message: string; details?: Array<{ path: string; message: string }> };
          }
      >;
      model?: string;
      request_id?: string;
    };
    const content = data.choices[0]?.message.content ?? '';
    opts.handlers.onMeta?.({
      request_id: data.request_id ?? '',
      model: data.model ?? '',
      chain: opts.chain,
    });
    // 非流式没有增量通道，思考文本整段带回
    if (data.reasoning) opts.handlers.onReasoning?.(data.reasoning);
    // 按时间线原顺序回放 thought / tool_call / tool_result
    for (const item of data.timeline ?? []) {
      if (item.kind === 'thought') {
        opts.handlers.onThought?.({ kind: 'thought', step: item.step, text: item.text, ts: Date.now() });
      } else {
        opts.handlers.onToolCall?.({
          kind: 'tool',
          callId: item.call_id,
          name: item.name,
          args: item.args,
          status: 'running',
        });
        opts.handlers.onToolResult?.(item.call_id, {
          status: item.status,
          latencyMs: item.latency_ms,
          data: item.data,
          error: item.error,
        });
      }
    }
    opts.handlers.onToken?.(content);
    if (data.citations?.length) opts.handlers.onCitation?.(data.citations);
    // 非流式同样消费 boundary：否则关掉流式开关后 D6/D7 的三态横幅会消失
    if (data.boundary) opts.handlers.onBoundary?.(data.boundary as Boundary);
    opts.handlers.onDone?.({ finish_reason: data.choices[0]?.finish_reason ?? 'stop', total_ms: 0 });
    return;
  }

  if (!res.body) throw new Error('网关未返回响应体');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  const dispatch = (msg: SseMessage) => {
    switch (msg.event) {
      case 'meta':
        opts.handlers.onMeta?.({
          request_id: msg.data.request_id,
          model: msg.data.model,
          chain: msg.data.chain as Chain,
        });
        break;
      case 'thought':
        opts.handlers.onThought?.({ kind: 'thought', step: msg.data.step, text: msg.data.text, ts: Date.now() });
        break;
      case 'reasoning':
        opts.handlers.onReasoning?.(msg.data.delta);
        break;
      case 'tool_call':
        opts.handlers.onToolCall?.({
          kind: 'tool',
          callId: msg.data.call_id,
          name: msg.data.name,
          args: msg.data.args,
          status: 'running',
        });
        break;
      case 'tool_result':
        opts.handlers.onToolResult?.(msg.data.call_id, {
          status: msg.data.status,
          latencyMs: msg.data.latency_ms,
          data: msg.data.data,
          error: msg.data.error,
        });
        break;
      case 'token':
        opts.handlers.onToken?.(msg.data.delta);
        break;
      case 'citation':
        opts.handlers.onCitation?.(msg.data.sources as Citation[]);
        break;
      case 'handoff':
        opts.handlers.onHandoff?.(msg.data.reason);
        opts.handlers.onBoundary?.(msg.data.boundary);
        break;
      case 'done':
        opts.handlers.onDone?.({
          finish_reason: msg.data.finish_reason,
          total_ms: msg.data.total_ms,
          usage: msg.data.usage,
        });
        break;
      case 'error':
        opts.handlers.onError?.(msg.data);
        break;
      default:
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const evt of parser.push(decoder.decode(value, { stream: true }))) dispatch(evt);
  }
  for (const evt of parser.flush()) dispatch(evt);
}

export interface HealthPayload {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  checks: Record<string, { status: string; detail?: string; latency_ms?: number }>;
}

export async function fetchHealth(): Promise<HealthPayload> {
  const res = await fetch(`${GATEWAY_BASE}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as HealthPayload;
}
