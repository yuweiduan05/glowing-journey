import { describe, expect, it } from 'vitest';
import { ToolRegistry, deriveIdempotencyKey } from '../tools/registry.js';
import { MockProvider } from '../providers/mock.js';
import type { ChatMessage } from '@app/shared';

/**
 * 工具层单测：不依赖真实下游（校验发生在 HTTP 之前），
 * 覆盖「参数非法 → 422 + 字段级 details」「未注册工具」「JSON 坏掉」三类。
 */
const registry = new ToolRegistry({
  businessBaseUrl: 'http://127.0.0.1:1',
  ragBaseUrl: 'http://127.0.0.1:1',
  toolTimeoutMs: 200,
  ragTimeoutMs: 200,
});

const ctx = { customerId: 'C-10087', conversationId: 'c-test' };

describe('ToolRegistry 参数校验', () => {
  it('SKU 格式错误 → TOOL_ARGS_INVALID 且带字段路径', async () => {
    const out = await registry.execute('query_inventory', JSON.stringify({ sku: 'A1B2C3' }), 'c1', ctx);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('TOOL_ARGS_INVALID');
    expect(out.error?.details?.[0]?.path).toBe('/sku');
  });

  it('模型传入 customer_id → 被 strict schema 拒绝（数据边界）', async () => {
    const out = await registry.execute(
      'query_order',
      JSON.stringify({ order_no: 'SO-20261012-007', customer_id: 'C-10099' }),
      'c2',
      ctx,
    );
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('TOOL_ARGS_INVALID');
  });

  it('工单摘要不足 20 字 → 拒绝', async () => {
    const out = await registry.execute(
      'create_ticket',
      JSON.stringify({ category: 'LOGISTICS', severity: 'S3', summary: '少发了' }),
      'c3',
      ctx,
    );
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('TOOL_ARGS_INVALID');
  });

  it('未注册的工具名被拒', async () => {
    const out = await registry.execute('drop_database', '{}', 'c4', ctx);
    expect(out.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('坏 JSON 被拒', async () => {
    const out = await registry.execute('query_inventory', '{sku:', 'c5', ctx);
    expect(out.error?.code).toBe('TOOL_ARGS_INVALID');
  });

  it('下游不可达 → TOOL_UPSTREAM_ERROR', async () => {
    const out = await registry.execute(
      'query_inventory',
      JSON.stringify({ sku: 'SKU-A1B2C3' }),
      'c6',
      { ...ctx, retryRead: false },
    );
    expect(out.status).toBe('error');
    expect(['TOOL_UPSTREAM_ERROR', 'TOOL_TIMEOUT']).toContain(out.error?.code);
  });
});

describe('幂等键派生（A3 决策：服务端派生，不是模型生成）', () => {
  it('同会话同订单同类别 → 稳定且是合法 UUID', () => {
    const a = deriveIdempotencyKey('c-1', { order_no: 'SO-20261012-007', category: 'LOGISTICS' });
    const b = deriveIdempotencyKey('c-1', { order_no: 'SO-20261012-007', category: 'LOGISTICS' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('同会话同订单同类别但问题不同 → 键不同（不吞单）', () => {
    const a = deriveIdempotencyKey('c-1', {
      order_no: 'SO-20261012-007',
      category: 'LOGISTICS',
      summary: '客户反馈订单少发一件，要求补发并承担运费。',
    });
    const b = deriveIdempotencyKey('c-1', {
      order_no: 'SO-20261012-007',
      category: 'LOGISTICS',
      summary: '客户反馈外箱破损，内件缺少缓冲材料，要求换货。',
    });
    expect(a).not.toBe(b);
  });

  it('同一句话只改标点/空白 → 键相同（仍能幂等去重）', () => {
    const a = deriveIdempotencyKey('c-1', {
      order_no: 'SO-20261012-007',
      category: 'LOGISTICS',
      summary: '客户反馈少发一件，要求补发。',
    });
    const b = deriveIdempotencyKey('c-1', {
      order_no: 'SO-20261012-007',
      category: 'LOGISTICS',
      summary: '客户反馈少发一件  ，要求补发！',
    });
    expect(a).toBe(b);
  });

  it('换会话/换类别 → 键不同（避免跨场景误命中）', () => {
    const base = deriveIdempotencyKey('c-1', { order_no: 'SO-1', category: 'LOGISTICS' });
    expect(deriveIdempotencyKey('c-2', { order_no: 'SO-1', category: 'LOGISTICS' })).not.toBe(base);
    expect(deriveIdempotencyKey('c-1', { order_no: 'SO-1', category: 'QUALITY' })).not.toBe(base);
  });
});

describe('Mock 模型的工具决策（离线演示可用性）', () => {
  const provider = new MockProvider();

  async function decide(content: string): Promise<string[]> {
    const messages: ChatMessage[] = [{ role: 'user', content }];
    const names: string[] = [];
    for await (const chunk of provider.stream(
      { messages, tools: [] },
      new AbortController().signal,
    )) {
      if (chunk.type === 'done') names.push(...chunk.toolCalls.map((c) => c.name));
    }
    return names;
  }

  it('库存问题 → query_inventory', async () => {
    expect(await decide('深圳仓 SKU-A1B2C3 还有多少可用库存？')).toEqual(['query_inventory']);
  });

  it('订单问题 → query_order', async () => {
    expect(await decide('订单 SO-20261012-007 到哪了？')).toEqual(['query_order']);
  });

  it('少发建单 → create_ticket', async () => {
    expect(await decide('订单 SO-20261012-007 少发了一件，帮我建个工单')).toEqual(['create_ticket']);
  });

  it('政策问题 → search_knowledge', async () => {
    expect(await decide('保修期是多久？')).toEqual(['search_knowledge']);
  });

  it('混合问题 → 同一轮并行发起业务 + 知识调用（不被截断）', async () => {
    expect(await decide('SKU-A1B2C3 的保修期是多久？顺便看下深圳仓库存')).toEqual([
      'query_inventory',
      'search_knowledge',
    ]);
  });
});
