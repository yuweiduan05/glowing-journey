/**
 * 双链路适配（对应 2.5 双链表 + P1 任务 4）
 *
 * direct：单次调用，不重试、不降级，只做鉴权 / 审计 / 心跳 —— 体现「网关不改变协议」。
 * proxy ：429/5xx 退避重试 → 备用供应商降级 → 连续失败熔断（503 CIRCUIT_OPEN）。
 *
 * 两条链路共用同一套 SSE 事件契约，前端不感知差异。
 * 注意：一旦已经向前端吐过 token，就不能重试（会重复内容），只能报错。
 */
import { AppError } from '@app/shared';
import type { ModelChunk, ModelInvoker, ModelRequest } from './providers/types.js';

export type ChainName = 'direct' | 'proxy';

interface CircuitState {
  failures: number;
  openedUntil: number;
}

export interface ChainOptions {
  maxRetries: number;
  retryBaseMs: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
}

export class ModelChain {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly primary: ModelInvoker,
    private readonly fallback: ModelInvoker | undefined,
    private readonly opts: ChainOptions,
  ) {}

  private assertCircuit(name: string): void {
    const state = this.circuits.get(name);
    if (state && state.openedUntil > Date.now()) {
      throw new AppError('CIRCUIT_OPEN', {
        message: `模型通道 ${name} 已熔断，请稍后重试`,
        retryable: true,
      });
    }
  }

  private recordSuccess(name: string): void {
    this.circuits.delete(name);
  }

  private recordFailure(name: string): void {
    const state = this.circuits.get(name) ?? { failures: 0, openedUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.opts.circuitThreshold) {
      state.openedUntil = Date.now() + this.opts.circuitCooldownMs;
      state.failures = 0;
    }
    this.circuits.set(name, state);
  }

  /**
   * 单次尝试。useCircuit=false 时完全绕开熔断表（既不读取也不写入）——
   * direct 链路的语义就是「单次调用、不重试、不降级、也不被熔断」
   * （docs/architecture.md §3 差异矩阵：连续失败 ≥ 阈值时 direct 不熔断）。
   */
  private async *attempt(
    invoker: ModelInvoker,
    req: ModelRequest,
    signal: AbortSignal,
    emittedRef: { value: boolean },
    useCircuit = true,
  ): AsyncGenerator<ModelChunk> {
    if (useCircuit) this.assertCircuit(invoker.name);
    try {
      for await (const chunk of invoker.stream(req, signal)) {
        emittedRef.value = true;
        yield chunk;
      }
      if (useCircuit) this.recordSuccess(invoker.name);
    } catch (err) {
      if (useCircuit) this.recordFailure(invoker.name);
      throw err;
    }
  }

  async *invoke(req: ModelRequest, chain: ChainName, signal: AbortSignal): AsyncGenerator<ModelChunk> {
    if (chain === 'direct') {
      yield* this.attempt(this.primary, req, signal, { value: false }, false);
      return;
    }

    const emitted = { value: false };
    let lastError: unknown;
    const maxAttempts = this.opts.maxRetries + 1;

    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        yield* this.attempt(this.primary, req, signal, emitted);
        return;
      } catch (err) {
        lastError = err;
        if (emitted.value || signal.aborted) throw err;
        const retryable = err instanceof AppError ? err.retryable : true;
        if (!retryable || i === maxAttempts - 1) break;
        const backoff = this.opts.retryBaseMs * 2 ** i + Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    // 备用供应商降级
    if (this.fallback) {
      try {
        yield* this.attempt(this.fallback, req, signal, emitted);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError instanceof AppError
      ? lastError
      : new AppError('UPSTREAM_MODEL_ERROR', {
          message: `模型调用失败：${(lastError as Error)?.message ?? '未知错误'}`,
          cause: lastError,
        });
  }
}
