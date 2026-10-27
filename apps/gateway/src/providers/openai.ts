/**
 * OpenAI 兼容上游适配器（MODEL_PROVIDER=openai）
 *
 * 最容易写错的三处，这里逐条处理：
 * 1. `tool_calls` 是**增量 delta**，必须按 `index` 拼接 arguments（不是覆盖，也不是按 id 拼）；
 * 2. 流式响应必须逐行解析，不能假设一个 chunk 正好是一个完整事件；
 * 3. 客户端中断 / 超时必须能把 abort 传到上游 fetch。
 */
import { AppError, type ChatMessage } from '@app/shared';
import type { ModelChunk, ModelInvoker, ModelRequest, ToolCall } from './types.js';

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** DeepSeek / vLLM 等推理模型的思考增量；OpenAI 兼容层里也可能叫 reasoning */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  label?: string;
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content ?? '', tool_call_id: m.tool_call_id ?? '', name: m.name };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return { role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

export class OpenAIProvider implements ModelInvoker {
  readonly name: string;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.name = opts.label ?? opts.model;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk> {
    if (!this.opts.apiKey) {
      throw new AppError('UNAUTHORIZED', { message: 'MODEL_API_KEY 未配置，无法调用真实模型' });
    }

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AppError('UPSTREAM_MODEL_ERROR', {
        message: timeout.aborted ? '上游模型超时' : `上游模型连接失败：${(err as Error).message}`,
        cause: err,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        throw new AppError('RATE_LIMITED', { message: '上游模型限流，请稍后重试' });
      }
      throw new AppError('UPSTREAM_MODEL_ERROR', {
        message: `上游模型返回 ${res.status}：${text.slice(0, 300)}`,
      });
    }
    if (!res.body) {
      throw new AppError('UPSTREAM_MODEL_ERROR', { message: '上游模型未返回响应体' });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason = 'stop';
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const toolAcc = new Map<number, ToolCall>();

    /** 处理一个完整 SSE 事件的若干 data 行（生成器：text delta 需要向上游 yield） */
    const handleEvent = function* (rawEvent: string): Generator<ModelChunk> {
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIChunk;
        } catch {
          continue;
        }

        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          yield { type: 'text', delta: delta.content };
        }

        // 思考文本单独走 reasoning，不能混进 content：
        // 混进去会同时污染回答正文与 usage 估算，前端也无法折叠。
        const think = delta.reasoning_content ?? delta.reasoning;
        if (think) yield { type: 'reasoning', delta: think };

        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) {
            // 少数供应商会把 name 拆成多段，这里做增量拼接但避免整名重复
            if (!cur.name) cur.name = tc.function.name;
            else if (!cur.name.endsWith(tc.function.name!)) cur.name += tc.function.name;
          }
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // SSE 规范允许 \r\n 分帧（部分 vLLM / 兼容网关如此）：对「累积 buffer + 新 chunk」
        // 整体归一化，避免跨 chunk 的 \r\n 漏改；只认 '\n\n' 会永远匹配不到分隔符，
        // 导致 text/toolCalls 全空却被当成「无工具调用」静默结束。
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');
          yield* handleEvent(rawEvent);
        }
      }
      // flush 残留：流被截断时，末尾不完整的事件也尝试解析一次（与共享 SseParser.flush 对齐）
      const rest = buffer.trim();
      buffer = '';
      if (rest) yield* handleEvent(rest);
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v], i) => ({ ...v, id: v.id || `call_${i}` }))
      .filter((c) => c.name);

    yield { type: 'done', text, toolCalls, finishReason, usage };
  }
}
