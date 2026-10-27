/**
 * Agent 编排回路（对应 1.2「自然语言→意图识别→工具调用→汇总回复」）
 *
 * 结构：ReAct 风格的「模型决策 → 工具执行 → 结果回填」循环，最多 3 轮（可配），
 * 超限降级为「请补充信息」而不是死循环。
 *
 * 两个关键裁决（对应 P0 确认项）：
 * - A3：纯知识问题直接把 RAG 的 answer 流式转发，不做二次生成（引用天然一致）；
 *        同一轮里既有知识工具又有业务工具时，才让模型做二次汇总。
 * - A4：流式下错误一律以 error 事件下发，字段级 details 一并带上。
 */
import type { ChatMessage, Source, SseMessage, Boundary } from '@app/shared';
import { toOpenAITools } from '@app/shared';
import type { ModelChain, ChainName } from '../chain.js';
import type { ToolCall, Usage } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { SYSTEM_PROMPT } from './prompt.js';

export interface AgentOptions {
  requestId: string;
  conversationId: string;
  customerId: string;
  chain: ChainName;
  enableKnowledge: boolean;
  maxToolRounds: number;
  temperature?: number;
  /** 演示用故障注入：透传到 business-api */
  chaos?: string;
  signal: AbortSignal;
  emit: (msg: SseMessage) => void;
  logger?: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
}

export interface AgentResult {
  text: string;
  citations: Source[];
  boundary?: Boundary;
  // 流内错误走 error 事件；'error' 曾是死枚举（零处赋值），已移除
  finishReason: 'stop' | 'tool_limit' | 'handoff';
  usage: Usage;
  toolRounds: number;
}

export class AgentOrchestrator {
  constructor(
    private readonly chain: ModelChain,
    private readonly tools: ToolRegistry,
  ) {}

  async run(userMessages: ChatMessage[], opts: AgentOptions): Promise<AgentResult> {
    const toolDefs = toOpenAITools().filter(
      (t) => opts.enableKnowledge || t.function.name !== 'search_knowledge',
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...userMessages.filter((m) => m.role !== 'system'),
    ];

    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const citations: Source[] = [];
    let boundary: Boundary | undefined;
    let text = '';
    let businessCalls = 0;
    let knowledgeCalls = 0;
    let knowledgeAnswer: string | null = null;
    let rounds = 0;
    let lastRoundHadToolCalls = false;
    let finishReason: AgentResult['finishReason'] = 'stop';

    for (let round = 1; round <= opts.maxToolRounds; round += 1) {
      rounds = round;
      // 每轮复位：语义必须是「最后一轮是否还在请求工具」。
      // 曾把它声明在循环外只置 true——任何一轮调过工具就永久为真，
      // 「轮1工具 → 轮2工具 → 轮3正常作答」会被误标 tool_limit（真实模型必踩）。
      lastRoundHadToolCalls = false;

      if (round === 1) {
        opts.emit({ event: 'thought', data: { step: 'intent', text: '正在分析问题意图，判断需要调用哪些工具' } });
      }

      let roundText = '';
      let toolCalls: ToolCall[] = [];

      for await (const chunk of this.chain.invoke(
        { messages, tools: toolDefs, temperature: opts.temperature },
        opts.chain,
        opts.signal,
      )) {
        if (chunk.type === 'text') {
          roundText += chunk.delta;
          text += chunk.delta;
          opts.emit({ event: 'token', data: { delta: chunk.delta } });
        } else if (chunk.type === 'reasoning') {
          // 思考文本只用于前端灰字流，绝不并入 text（否则会污染最终回答与引用对齐）
          opts.emit({ event: 'reasoning', data: { delta: chunk.delta } });
        } else {
          toolCalls = chunk.toolCalls;
          usage.prompt_tokens += chunk.usage.prompt_tokens;
          usage.completion_tokens += chunk.usage.completion_tokens;
          usage.total_tokens += chunk.usage.total_tokens;
        }
      }

      // 模型不再请求工具 = 自然结束（唯一可信的「模型已终止」信号）
      if (toolCalls.length === 0) {
        finishReason = 'stop';
        break;
      }
      lastRoundHadToolCalls = true;

      opts.emit({
        event: 'thought',
        data: {
          step: 'plan',
          text: `计划调用 ${toolCalls.map((c) => c.name).join(' → ')}（第 ${round}/${opts.maxToolRounds} 轮）`,
        },
      });

      // 先回填 assistant 的 tool_calls，再逐条回填 tool 结果，顺序不能反
      messages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const call of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        } catch {
          parsedArgs = { _raw: call.arguments };
        }

        opts.emit({
          event: 'tool_call',
          data: { call_id: call.id, name: call.name, args: parsedArgs },
        });

        // 知识库开关的执行层守卫：只过滤下发工具表不够——mock 供应商不看工具表，
        // 真实模型也可能点名表外工具，两者都会让「关掉 RAG」后仍然检索（演示当场穿帮）。
        const knowledgeDisabled = call.name === 'search_knowledge' && !opts.enableKnowledge;
        const outcome = knowledgeDisabled
          ? {
              callId: call.id,
              name: call.name,
              status: 'ok' as const,
              latencyMs: 0,
              // 形状与真实工具输出一致（SearchKnowledgeOutputSchema），模型上下文不会错
              data: {
                answer: '知识库检索当前已关闭（enable_knowledge=false），本次未检索知识库。',
                sources: [],
                boundary: 'insufficient',
                confidence: 0,
              },
            }
          : await this.tools.execute(call.name, call.arguments, call.id, {
              customerId: opts.customerId,
              conversationId: opts.conversationId,
              requestId: opts.requestId,
              chaos: opts.chaos,
              retryRead: opts.chain === 'proxy',
              signal: opts.signal,
            });

        opts.emit({
          event: 'tool_result',
          data:
            outcome.status === 'ok'
              ? {
                  call_id: outcome.callId,
                  name: outcome.name,
                  status: 'ok',
                  latency_ms: outcome.latencyMs,
                  data: outcome.data,
                }
              : {
                  call_id: outcome.callId,
                  name: outcome.name,
                  status: 'error',
                  latency_ms: outcome.latencyMs,
                  error: outcome.error,
                },
        });

        messages.push({
          role: 'tool',
          name: call.name,
          tool_call_id: call.id,
          content: JSON.stringify(
            outcome.status === 'ok' ? outcome.data : { error: outcome.error },
          ),
        });

        if (outcome.status === 'ok') {
          if (call.name === 'search_knowledge' && !knowledgeDisabled) {
            knowledgeCalls += 1;
            const data = outcome.data as { answer: string; sources: Source[]; boundary: Boundary; trace?: string[] };
            knowledgeAnswer = data.answer;
            boundary = data.boundary;
            citations.push(...data.sources);
            // 把 RAG 状态图的节点流转透出为 thought（场景 2「状态图自适应」的可见证据：
            // route → rewrite → retrieve → …，重试时会看到多轮 rewrite/retrieve）
            if (data.trace?.length) {
              const retrieveRounds = data.trace.filter((n) => n === 'retrieve').length;
              opts.emit({
                event: 'thought',
                data: {
                  step: 'rag',
                  text: `知识库状态图：${data.trace.join(' → ')}（检索 ${retrieveRounds} 轮）`,
                },
              });
            }
          } else if (call.name !== 'search_knowledge') {
            // 被拦截的知识调用不计数：否则 boundary=insufficient 会误发「转人工」
            businessCalls += 1;
          }
        } else if (outcome.error) {
          opts.logger?.warn(
            {
              request_id: opts.requestId,
              conversation_id: opts.conversationId,
              tool: call.name,
              code: outcome.error.code,
            },
            'tool failed',
          );
        }
      }

      // 注意：这里不再按「截至目前没有业务工具调用」短路 break。
      // 真实模型对顺序型混合问题（「保修多久？顺便看库存」）会分多轮发起调用，
      // 第 1 轮只有 search_knowledge 时旧代码会提前 break，把库存部分静默吞掉。
      // A3 的「纯知识问题直接转发 RAG 答案」改为循环结束后按条件补播（见下方收尾）。
    }

    // ---- 循环结束后的收尾（顺序有意义：先补知识答案，再判轮次是否耗尽） ----

    // A3：整轮只有知识调用、且模型没有产出正文时，补播 RAG 答案
    // （answer 与 sources 由同一份证据生成，转发可保证引用一致）
    if (knowledgeCalls > 0 && businessCalls === 0 && knowledgeAnswer !== null && text.length === 0) {
      for (let i = 0; i < knowledgeAnswer.length; i += 16) {
        opts.emit({ event: 'token', data: { delta: knowledgeAnswer.slice(i, i + 16) } });
        await new Promise((r) => setTimeout(r, 8));
      }
      text = knowledgeAnswer;
      finishReason = boundary === 'in_kb' ? 'stop' : 'handoff';
    }

    if (rounds >= opts.maxToolRounds && lastRoundHadToolCalls && finishReason === 'stop') {
      // 轮次耗尽时模型仍在请求工具 → tool_limit。
      // 判据是「最后一轮是否产生 tool_calls」而不是「末条消息 role=tool」——
      // 后者会把模型最后一轮正常作答（末尾仍是上轮 tool 消息）误标为 tool_limit。
      const fallback = '已达到最大工具调用轮次，请补充更具体的信息（例如订单号、SKU 或期望的处理方式），我再继续。';
      if (!text) {
        for (let i = 0; i < fallback.length; i += 16) {
          opts.emit({ event: 'token', data: { delta: fallback.slice(i, i + 16) } });
        }
      }
      text = text || fallback;
      finishReason = 'tool_limit';
    }

    if (boundary && boundary !== 'in_kb') {
      opts.emit({
        event: 'handoff',
        data: {
          reason:
            boundary === 'insufficient'
              ? '知识库未覆盖该问题，建议转人工或创建工单跟进'
              : '问题超出业务范围，已按边界策略拒答并记录审计日志',
          boundary,
        },
      });
      if (boundary === 'out_of_scope') {
        opts.logger?.info(
          { request_id: opts.requestId, boundary, conversation_id: opts.conversationId },
          'out_of_scope refused',
        );
      }
    }

    if (citations.length) {
      opts.emit({
        event: 'citation',
        data: {
          sources: citations.map((s) => ({
            doc_title: s.doc_title,
            section: s.section,
            chunk_id: s.chunk_id,
            score: s.score,
            doc_id: s.doc_id,
            text: s.text,
          })),
        },
      });
    }

    return { text, citations, boundary, finishReason, usage, toolRounds: rounds };
  }
}
