/**
 * SSE 事件协议（对应 2.5「SSE 事件协议」，P0 冻结项）
 *
 * 10 类事件 + `: ping` 心跳，两条链路（direct / proxy）共用同一套契约，
 * 前端不感知链路差异 —— 这是「双链路适配」的实质。
 *
 * `thought` 与 `reasoning` 的分工：
 * - `thought`：编排器产出的**结构化步骤**（意图 / 计划 / RAG 状态图），用于时间线，离散且稳定；
 * - `reasoning`：模型自己产出的**思考文本增量**，只用于「正在思考」的灰字流，
 *   前端在正文首 token 到达后折叠，不参与最终回答内容。
 */
import type { ErrorCode, ErrorDetail } from './errors.js';
import type { Boundary, Source } from './schemas.js';

export const SSE_EVENT_NAMES = [
  'meta',
  'thought',
  'reasoning',
  'tool_call',
  'tool_result',
  'token',
  'citation',
  'handoff',
  'done',
  'error',
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

export interface MetaEvent {
  request_id: string;
  /** 双链路：direct 单次调用 / proxy 重试+降级+熔断 */
  chain: 'direct' | 'proxy';
  model: string;
  /** 补 A4 契约缺口：流式开关，stream | sync */
  mode: 'stream' | 'sync';
  ts: number;
}

export interface ThoughtEvent {
  step: string;
  text: string;
}

/**
 * 思考文本增量（模型侧 `reasoning_content` 的等价物）。
 * 与 `thought` 不同：它是连续文本，前端按字符串拼接后以灰字滚动展示。
 */
export interface ReasoningEvent {
  delta: string;
}

export interface ToolCallEvent {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  call_id: string;
  name: string;
  status: 'ok' | 'error';
  latency_ms: number;
  data?: unknown;
  error?: { code: ErrorCode; message: string; details?: ErrorDetail[] };
}

export interface TokenEvent {
  delta: string;
}

export interface CitationEvent {
  /** text 来自 RAG 检索片段原文（截断 400 字），供前端「点开看原文」；缺省时前端展示兜底文案 */
  sources: Array<Pick<Source, 'doc_title' | 'section' | 'chunk_id' | 'score' | 'text'> & { doc_id?: string }>;
}

export interface HandoffEvent {
  reason: string;
  /** 结构化边界：前端据此渲染三态横幅，禁止再靠 reason 中文子串猜 */
  boundary: Exclude<Boundary, 'in_kb'>;
}

export interface DoneEvent {
  // 流内错误走独立 error 事件；'error' 曾是死枚举（零处赋值），已移除
  finish_reason: 'stop' | 'tool_limit' | 'handoff';
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  total_ms: number;
}

export interface ErrorEvent {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** 字段级 details（流式下 HTTP 恒为 200，只能从这里下发） */
  details?: ErrorDetail[];
}

export interface SsePayloadMap {
  meta: MetaEvent;
  thought: ThoughtEvent;
  reasoning: ReasoningEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  token: TokenEvent;
  citation: CitationEvent;
  handoff: HandoffEvent;
  done: DoneEvent;
  error: ErrorEvent;
}

export type SseMessage = {
  [K in SseEventName]: { event: K; data: SsePayloadMap[K] };
}[SseEventName];

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // 关闭压缩与缓冲，否则事件会被攒成一批才到前端
  'Content-Encoding': 'identity',
  'X-Accel-Buffering': 'no',
} as const;

export { SSE_HEADERS };

export function serializeSse<K extends SseEventName>(event: K, data: SsePayloadMap[K]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function serializePing(): string {
  return ': ping\n\n';
}

/**
 * 增量 SSE 解析器：前端与单测共用。
 * 处理跨 chunk 截断、CRLF、注释行（`: ping`）、多事件粘包。
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: SseMessage[] = [];
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const parsed = parseBlock(raw);
      if (parsed) out.push(parsed);
      idx = this.buffer.indexOf('\n\n');
    }
    return out;
  }

  /** 流结束时把残留的不完整块也尝试解析一次 */
  flush(): SseMessage[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const parsed = parseBlock(rest);
    return parsed ? [parsed] : [];
  }
}

function parseBlock(raw: string): SseMessage | null {
  const lines = raw.split('\n');
  let event = '';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event || dataLines.length === 0) return null;
  if (!(SSE_EVENT_NAMES as readonly string[]).includes(event)) return null;
  try {
    const data = JSON.parse(dataLines.join('\n'));
    return { event, data } as SseMessage;
  } catch {
    return null;
  }
}

/** boundary 三态在前端的呈现口径（对应 2.3 网关处置规则） */
export const BOUNDARY_LABEL: Record<Boundary, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  in_kb: { label: '知识库已覆盖', tone: 'ok' },
  insufficient: { label: '知识库未覆盖', tone: 'warn' },
  out_of_scope: { label: '超出业务范围', tone: 'danger' },
};
