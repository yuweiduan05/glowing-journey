import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import type { ServerResponse } from 'node:http';
import { OpenAIProvider } from '../providers/openai.js';
import type { ModelRequest } from '../providers/types.js';

/**
 * provider 层测试：openai.ts 自己解析上游 SSE（与共享 SseParser 是两套代码），
 * 曾因只认 '\n\n' 且不 flush 残留，在 CRLF 分帧的上游（部分 vLLM / 兼容网关）下
 * 整条流静默丢失。这里用本地假上游逐条钉死行为。
 */

const req: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

const openers: Server[] = [];

afterEach(async () => {
  while (openers.length) {
    const s = openers.pop();
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }
});

/** 起一个按脚本写入的假上游，把 provider 交给用例 */
async function withUpstream(
  script: (res: ServerResponse) => void,
  fn: (provider: OpenAIProvider) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    // 消费请求体，避免背压
    req.resume();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    script(res);
  });
  openers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await fn(new OpenAIProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'fake', timeoutMs: 5000 }));
}

interface Collected {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string;
}

async function collect(provider: OpenAIProvider): Promise<Collected> {
  let text = '';
  let toolCalls: Collected['toolCalls'] = [];
  let finishReason = '';
  for await (const chunk of provider.stream(req, AbortSignal.timeout(8000))) {
    if (chunk.type === 'done') {
      text = chunk.text;
      toolCalls = chunk.toolCalls;
      finishReason = chunk.finishReason;
    }
  }
  return { text, toolCalls, finishReason };
}

/** 按固定间隔逐条写出事件；sep 控制分帧符（默认 LF，可传 CRLF） */
function scriptedWrite(events: string[], opts: { sep?: string; intervalMs?: number } = {}) {
  const sep = opts.sep ?? '\n\n';
  const interval = opts.intervalMs ?? 5;
  return (res: ServerResponse) => {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= events.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(events[i] + sep);
      i += 1;
    }, interval);
    res.on('close', () => clearInterval(timer));
  };
}

const TEXT_EVENTS = [
  'data: {"choices":[{"delta":{"content":"你好"}}]}',
  'data: {"choices":[{"delta":{"content":"，世界"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
  'data: [DONE]',
];

describe('OpenAIProvider 上游 SSE 解析', () => {
  it('CRLF 分帧（\\r\\n\\r\\n）也能完整解析，不静默丢流', async () => {
    await withUpstream(scriptedWrite(TEXT_EVENTS, { sep: '\r\n\r\n' }), async (provider) => {
      const out = await collect(provider);
      expect(out.text).toBe('你好，世界');
      expect(out.finishReason).toBe('stop');
    });
  });

  it('事件被切碎到跨 chunk（每片 7 字节，含多字节汉字）也不丢', async () => {
    await withUpstream((res) => {
      const payload = TEXT_EVENTS.join('\n\n') + '\n\n';
      let i = 0;
      const timer = setInterval(() => {
        if (i >= payload.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(payload.slice(i, i + 7));
        i += 7;
      }, 2);
      res.on('close', () => clearInterval(timer));
    }, async (provider) => {
      const out = await collect(provider);
      expect(out.text).toBe('你好，世界');
      expect(out.finishReason).toBe('stop');
    });
  });

  it('一个 chunk 里粘包两个事件都能解析', async () => {
    await withUpstream((res) => {
      res.write(TEXT_EVENTS[0] + '\n\n' + TEXT_EVENTS[1] + '\n\n');
      res.write(TEXT_EVENTS[2] + '\n\n' + TEXT_EVENTS[3] + '\n\n');
      res.end();
    }, async (provider) => {
      const out = await collect(provider);
      expect(out.text).toBe('你好，世界');
      expect(out.finishReason).toBe('stop');
    });
  });

  it('流被截断（无末尾空行）时 flush 残留事件', async () => {
    await withUpstream((res) => {
      // 故意不发结尾的 \n\n 与 [DONE]，直接结束
      res.write(TEXT_EVENTS[0] + '\n\n' + TEXT_EVENTS[1] + '\n\n' + TEXT_EVENTS[2]);
      res.end();
    }, async (provider) => {
      const out = await collect(provider);
      expect(out.text).toBe('你好，世界');
      expect(out.finishReason).toBe('stop');
    });
  });

  it('tool_calls 增量按 index 累积（arguments 分段 + 并行双工具）', async () => {
    const toolEvents = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"query_in","arguments":"{\\"sku\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"search_know","arguments":"{\\"q\\":\\"保"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SKU-A1B2C3\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"修\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ];
    await withUpstream(scriptedWrite(toolEvents, { sep: '\r\n\r\n' }), async (provider) => {
      const out = await collect(provider);
      expect(out.toolCalls).toHaveLength(2);
      expect(out.toolCalls[0]).toEqual({ id: 'call_a', name: 'query_in', arguments: '{"sku":"SKU-A1B2C3"}' });
      expect(out.toolCalls[1]).toEqual({ id: 'call_b', name: 'search_know', arguments: '{"q":"保修"}' });
      expect(out.finishReason).toBe('tool_calls');
    });
  });
});
