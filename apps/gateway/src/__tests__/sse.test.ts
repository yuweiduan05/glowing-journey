import { describe, expect, it } from 'vitest';
import { SseParser, serializeSse, type SsePayloadMap } from '@app/shared';

describe('SSE 解析器（ADR-004：前端用 fetch 流式读取）', () => {
  it('跨 chunk 截断的单个事件也能正确解析', () => {
    const parser = new SseParser();
    const raw = serializeSse('token', { delta: '你好' });

    // 故意在 event 与 data 中间切断
    const first = parser.push(raw.slice(0, 12));
    expect(first).toHaveLength(0);

    const rest = parser.push(raw.slice(12));
    expect(rest).toHaveLength(1);
    expect(rest[0]).toEqual({ event: 'token', data: { delta: '你好' } });
  });

  it('忽略心跳注释行，并支持一次收到多个事件', () => {
    const parser = new SseParser();
    const payload =
      ': ping\n\n' +
      serializeSse('thought', { step: 'intent', text: '识别意图' }) +
      serializeSse('done', {
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        total_ms: 12,
      });

    const events = parser.push(payload);
    expect(events.map((e) => e.event)).toEqual(['thought', 'done']);
  });

  it('兼容 CRLF 与未知事件名', () => {
    const parser = new SseParser();
    const crlf = serializeSse('token', { delta: 'a' }).replace(/\n/g, '\r\n');
    const events = parser.push(`${crlf}event: unknown\ndata: {"x":1}\n\n`);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('token');
  });

  it('9 类事件都能序列化并可回读', () => {
    const cases: Array<[keyof SsePayloadMap, SsePayloadMap[keyof SsePayloadMap]]> = [
      ['meta', { request_id: 'r1', chain: 'proxy', model: 'm', mode: 'stream', ts: 1 }],
      ['thought', { step: 'intent', text: 't' }],
      ['tool_call', { call_id: 'c1', name: 'query_inventory', args: { sku: 'SKU-A1B2C3' } }],
      [
        'tool_result',
        { call_id: 'c1', name: 'query_inventory', status: 'ok', latency_ms: 10, data: { available: 17 } },
      ],
      ['token', { delta: 'x' }],
      ['citation', { sources: [{ doc_title: 'd', section: 's', chunk_id: 'c', score: 0.5 }] }],
      ['handoff', { reason: '知识库未覆盖', boundary: 'insufficient' }],
      [
        'done',
        { finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, total_ms: 3 },
      ],
      ['error', { code: 'TOOL_TIMEOUT', message: '超时', retryable: true }],
    ];

    const parser = new SseParser();
    for (const [event, data] of cases) {
      const events = parser.push(serializeSse(event, data));
      expect(events[0]?.event).toBe(event);
    }
  });
});
