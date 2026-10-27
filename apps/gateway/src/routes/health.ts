/**
 * /health 聚合（对应 P3 任务 7：三服务健康指示条）
 * 用 1.5s 超时探测下游，任何一个 down → overall degraded。
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../env.js';

interface Check {
  status: 'ok' | 'degraded' | 'down';
  detail?: string;
  latency_ms?: number;
}

async function probe(url: string): Promise<Check> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const latency = Date.now() - started;
    if (!res.ok) return { status: 'down', detail: `HTTP ${res.status}`, latency_ms: latency };
    return { status: 'ok', latency_ms: latency };
  } catch (err) {
    return { status: 'down', detail: (err as Error).message, latency_ms: Date.now() - started };
  }
}

export function registerHealthRoutes(app: FastifyInstance, modelLabel: string): void {
  app.get('/health', async () => {
    const [business, rag] = await Promise.all([
      probe(`${config.businessBaseUrl}/health`),
      probe(`${config.ragBaseUrl}/health`),
    ]);

    const checks: Record<string, Check> = {
      'business-api': business,
      'rag-service': rag,
      'model-provider': {
        status: config.model.provider === 'mock' || config.model.apiKey ? 'ok' : 'degraded',
        detail: config.model.provider === 'mock' ? 'mock（离线确定性回复）' : modelLabel,
      },
    };

    const status = Object.values(checks).some((c) => c.status === 'down')
      ? 'degraded'
      : Object.values(checks).some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'ok';

    return {
      status,
      service: 'gateway',
      version: '0.1.0',
      ts: Date.now(),
      checks,
    };
  });

  app.get('/v1/models', async () => ({
    object: 'list',
    data: [{ id: modelLabel, object: 'model', owned_by: 'gateway' }],
  }));
}
