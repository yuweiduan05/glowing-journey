import { describe, expect, it } from 'vitest';
import type { SseMessage } from '@app/shared';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { ModelChain } from '../chain.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ModelChunk, ModelInvoker, ModelRequest } from '../providers/types.js';

/**
 * 编排回路单测（R2 审查 P1-A / P1-B 的护栏）：
 * - tool_limit 只能是「轮次用尽且模型仍在请求工具」，最后一轮正常作答必须是 stop；
 * - enable_knowledge=false 时 search_knowledge 在执行层被拦截，不触达下游。
 *
 * 这两个用例都对应真实模型路径（mock 两轮内结束，D1–D8 覆盖不到）。
 */

type Step = 'query_inventory' | 'search_knowledge' | 'text';

/** 按脚本逐轮响应的假模型：前 N 轮发工具调用，最后一轮正常作答 */
class ScriptedInvoker implements ModelInvoker {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly script: Step[],
  ) {}

  async *stream(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)] ?? 'text';
    this.calls += 1;
    if (signal.aborted) throw new Error('aborted');

    if (step === 'text') {
      yield { type: 'text', delta: '最终答复' };
      yield {
        type: 'done',
        text: '最终答复',
        toolCalls: [],
        finishReason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return;
    }

    yield {
      type: 'done',
      text: '',
      toolCalls: [
        {
          id: `call_${this.calls}`,
          name: step,
          arguments: step === 'search_knowledge' ? JSON.stringify({ question: '保修期多久？' }) : JSON.stringify({ sku: 'SKU-A1B2C3' }),
        },
      ],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

const registry = new ToolRegistry({
  businessBaseUrl: 'http://127.0.0.1:1', // 不可达：工具调用必然失败，不影响回路判定
  ragBaseUrl: 'http://127.0.0.1:1',
  toolTimeoutMs: 200,
  ragTimeoutMs: 200,
});

const chainOpts = { maxRetries: 0, retryBaseMs: 1, circuitThreshold: 3, circuitCooldownMs: 50 };

function baseOptions(overrides: { enableKnowledge?: boolean; maxToolRounds?: number; emit?: (m: SseMessage) => void } = {}) {
  return {
    requestId: 'r-test',
    conversationId: 'c-test',
    customerId: 'C-10087',
    chain: 'direct' as const,
    enableKnowledge: overrides.enableKnowledge ?? true,
    maxToolRounds: overrides.maxToolRounds ?? 3,
    signal: AbortSignal.timeout(8000),
    emit: overrides.emit ?? (() => {}),
  };
}

describe('编排回路：tool_limit 判定（R2 P1-A）', () => {
  it('轮次用满但最后一轮正常作答 → stop（不得误标 tool_limit）', async () => {
    // 轮1 工具 → 轮2 工具 → 轮3 作答：修复前 lastRoundHadToolCalls 从不复位，会误标
    const invoker = new ScriptedInvoker('primary', ['query_inventory', 'query_inventory', 'text']);
    const orchestrator = new AgentOrchestrator(new ModelChain(invoker, undefined, chainOpts), registry);
    const result = await orchestrator.run([{ role: 'user', content: '查库存' }], baseOptions({ maxToolRounds: 3 }));
    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('最终答复');
    expect(result.toolRounds).toBe(3);
  });

  it('轮次用尽且模型仍在请求工具 → tool_limit', async () => {
    const invoker = new ScriptedInvoker('primary', ['query_inventory', 'query_inventory', 'query_inventory', 'query_inventory']);
    const orchestrator = new AgentOrchestrator(new ModelChain(invoker, undefined, chainOpts), registry);
    const result = await orchestrator.run([{ role: 'user', content: '查库存' }], baseOptions({ maxToolRounds: 2 }));
    expect(result.finishReason).toBe('tool_limit');
  });

  it('提前正常作答（未用满轮次）→ stop', async () => {
    const invoker = new ScriptedInvoker('primary', ['query_inventory', 'text', 'text']);
    const orchestrator = new AgentOrchestrator(new ModelChain(invoker, undefined, chainOpts), registry);
    const result = await orchestrator.run([{ role: 'user', content: '查库存' }], baseOptions({ maxToolRounds: 3 }));
    expect(result.finishReason).toBe('stop');
    expect(result.toolRounds).toBe(2);
  });
});

describe('编排回路：enable_knowledge 执行拦截（R2 P1-B）', () => {
  it('关开关后 search_knowledge 被拦截：合成结果 + 不触达下游 + 不误发 handoff', async () => {
    const invoker = new ScriptedInvoker('primary', ['search_knowledge', 'text']);
    const orchestrator = new AgentOrchestrator(new ModelChain(invoker, undefined, chainOpts), registry);
    const events: SseMessage[] = [];
    const result = await orchestrator.run(
      [{ role: 'user', content: '保修期多久？' }],
      baseOptions({ enableKnowledge: false, emit: (m) => events.push(m) }),
    );

    const toolCall = events.find((e) => e.event === 'tool_call');
    const toolResult = events.find((e) => e.event === 'tool_result');
    expect(toolCall).toBeDefined();
    expect(toolResult?.data.status).toBe('ok');
    expect((toolResult?.data.data as { answer: string }).answer).toContain('已关闭');
    // 被拦截的调用不得计入知识调用：否则 boundary=insufficient 会误发「转人工」
    expect(events.some((e) => e.event === 'handoff')).toBe(false);
    expect(events.some((e) => e.event === 'citation')).toBe(false);
    expect(result.finishReason).toBe('stop');
  });

  it('开开关时行为不变：search_knowledge 正常执行（下游不可达 → 工具错误但不拦截）', async () => {
    const invoker = new ScriptedInvoker('primary', ['search_knowledge', 'text']);
    const orchestrator = new AgentOrchestrator(new ModelChain(invoker, undefined, chainOpts), registry);
    const events: SseMessage[] = [];
    await orchestrator.run(
      [{ role: 'user', content: '保修期多久？' }],
      baseOptions({ enableKnowledge: true, emit: (m) => events.push(m) }),
    );
    const toolResult = events.find((e) => e.event === 'tool_result');
    expect(toolResult?.data.status).toBe('error'); // 真的去调了下游（不可达）
    expect((toolResult?.data.data as { answer?: string } | undefined)?.answer).toBeUndefined();
  });
});
