/**
 * 对外 DTO：网关 /v1/chat/completions 采用 OpenAI 兼容外形，
 * 附加字段（conversation_id / enable_knowledge / citations）均以扩展形式出现，
 * 不破坏既有 OpenAI 客户端解析。
 */
import { z } from 'zod';
import { BoundarySchema, SourceSchema } from './schemas.js';

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1, 'messages 不能为空'),
  stream: z.boolean().optional().default(true),
  conversation_id: z.string().min(1).max(64).optional(),
  /** 知识库工具开关：关掉可演示「不带 RAG 也能跑」（P3 任务 5） */
  enable_knowledge: z.boolean().optional().default(true),
  /** 最大工具轮次，缺省 3（1.2 编排回路要求） */
  max_tool_rounds: z.number().int().min(1).max(5).optional().default(3),
  temperature: z.number().min(0).max(2).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string; tool_calls?: ChatMessage['tool_calls'] };
    finish_reason: 'stop' | 'tool_limit' | 'handoff';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 扩展：引用与边界，便于非流式联调断言 */
  citations?: Array<z.infer<typeof SourceSchema>>;
  boundary?: z.infer<typeof BoundarySchema>;
  /**
   * 扩展：模型思考文本（非流式）。流式下走 `reasoning` 事件，
   * 非流式没有增量通道，只能整段带回，保证两种模式的「思考」呈现一致。
   */
  reasoning?: string;
  /**
   * 非流式时的事件时间线（与流式 SSE 等价）：关掉流式开关也不能丢
   * 「思考 → 调用 → 结果」的可解释性（审查报告 §3.6）。
   */
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
        error?: { code: string; message: string; details?: Array<{ path: string; message: string; code?: string }> };
      }
  >;
  request_id: string;
}

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export interface HealthResponse {
  status: HealthStatus;
  service: string;
  version: string;
  ts: number;
  uptime_s?: number;
  checks: Record<string, { status: HealthStatus; detail?: string; latency_ms?: number }>;
}
