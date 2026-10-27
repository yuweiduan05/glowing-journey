import type { ChatMessage } from '@app/shared';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串（OpenAI 语义：arguments 是字符串，不是对象） */
  arguments: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type ModelChunk =
  | { type: 'text'; delta: string }
  /** 模型思考增量：不进入回答正文，只用于前端「正在思考」的灰字流 */
  | { type: 'reasoning'; delta: string }
  | {
      type: 'done';
      text: string;
      toolCalls: ToolCall[];
      finishReason: string;
      usage: Usage;
    };

export interface ModelRequest {
  messages: ChatMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  temperature?: number;
}

export interface ModelInvoker {
  readonly name: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk>;
}

export function estimateUsage(messages: ChatMessage[], text: string): Usage {
  const prompt = messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + 8, 0);
  const promptTokens = Math.ceil(prompt / 4);
  const completionTokens = Math.ceil(text.length / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}
