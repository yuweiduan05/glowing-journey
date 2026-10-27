import { describe, expect, it } from 'vitest';
import { AppError } from '@app/shared';
import { ModelChain } from '../chain.js';
import type { ModelChunk, ModelInvoker, ModelRequest } from '../providers/types.js';

/** 前 N 次抛 5xx，之后成功 */
class FlakyInvoker implements ModelInvoker {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly failTimes: number,
    private readonly failCode: 'UPSTREAM_MODEL_ERROR' | 'INVALID_ARGUMENT' = 'UPSTREAM_MODEL_ERROR',
  ) {}

  async *stream(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk> {
    this.calls += 1;
    if (this.calls <= this.failTimes) {
      throw new AppError(this.failCode, { message: '注入失败' });
    }
    if (signal.aborted) throw new Error('aborted');
    yield { type: 'text', delta: 'ok' };
    yield {
      type: 'done',
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

const req: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };
const opts = { maxRetries: 2, retryBaseMs: 1, circuitThreshold: 3, circuitCooldownMs: 50 };

async function collect(gen: AsyncGenerator<ModelChunk>) {
  const out: string[] = [];
  for await (const chunk of gen) {
    if (chunk.type === 'text') out.push(chunk.delta);
  }
  return out.join('');
}

describe('双链路容灾（direct vs proxy）', () => {
  it('direct 不重试：一次失败即抛出', async () => {
    const invoker = new FlakyInvoker('primary', 1);
    const chain = new ModelChain(invoker, undefined, opts);
    await expect(collect(chain.invoke(req, 'direct', new AbortController().signal))).rejects.toThrow('注入失败');
    expect(invoker.calls).toBe(1);
  });

  it('proxy 对可重试错误退避重试，最终成功', async () => {
    const invoker = new FlakyInvoker('primary', 2);
    const chain = new ModelChain(invoker, undefined, opts);
    await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).resolves.toBe('ok');
    expect(invoker.calls).toBe(3);
  });

  it('不可重试错误（4xx 语义）不浪费重试次数', async () => {
    const invoker = new FlakyInvoker('primary', 9, 'INVALID_ARGUMENT');
    const chain = new ModelChain(invoker, undefined, opts);
    await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).rejects.toThrow();
    expect(invoker.calls).toBe(1);
  });

  it('主供应商持续失败 → 降级到备用供应商', async () => {
    const primary = new FlakyInvoker('primary', 99);
    const fallback = new FlakyInvoker('fallback', 0);
    const chain = new ModelChain(primary, fallback, opts);
    await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).resolves.toBe('ok');
    expect(fallback.calls).toBe(1);
  });

  it('连续失败达到阈值后熔断，返回 CIRCUIT_OPEN', async () => {
    const invoker = new FlakyInvoker('primary', 99);
    const chain = new ModelChain(invoker, undefined, { ...opts, maxRetries: 0 });

    // 阈值 3：连续三次失败后打开熔断
    for (let i = 0; i < 3; i += 1) {
      await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).rejects.toThrow();
    }
    await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });
  });

  it('熔断打开后 direct 仍可单次调用（direct 不熔断）', async () => {
    const invoker = new FlakyInvoker('primary', 99);
    const chain = new ModelChain(invoker, undefined, { ...opts, maxRetries: 0 });

    // proxy 连续失败打开熔断
    for (let i = 0; i < 3; i += 1) {
      await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).rejects.toThrow();
    }
    await expect(collect(chain.invoke(req, 'proxy', new AbortController().signal))).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });

    // direct 绕开熔断表：仍到达上游（上游持续失败，抛的是注入失败而非 CIRCUIT_OPEN）
    await expect(collect(chain.invoke(req, 'direct', new AbortController().signal))).rejects.toThrow('注入失败');
    expect(invoker.calls).toBe(4);
  });
});
