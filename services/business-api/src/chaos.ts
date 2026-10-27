/**
 * 故障注入（对应 P1 任务 6：`?chaos=slow|fail|500`）
 *
 * 只对业务接口生效，/health 不注入，否则健康检查会被自己的故障注入打死。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ChaosMode = 'slow' | 'fail' | '500';

const SLEEP_MS = 1200;

export function registerChaos(app: FastifyInstance, enabled: boolean): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!enabled) return;
    if (req.url.startsWith('/health')) return;

    const raw = (req.query as Record<string, string | undefined> | undefined)?.chaos;
    const mode = raw as ChaosMode | undefined;
    if (!mode) return;

    if (mode === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
      return;
    }

    if (mode === 'fail') {
      await reply.status(503).send({
        code: 'TOOL_UPSTREAM_ERROR',
        message: '注入故障：业务服务暂不可用',
        request_id: String(req.id),
        retryable: true,
      });
      return;
    }

    if (mode === '500') {
      await reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: '注入故障：业务服务内部错误',
        request_id: String(req.id),
        retryable: true,
      });
      return;
    }

    await reply.status(400).send({
      code: 'INVALID_ARGUMENT',
      message: `未知的 chaos 模式：${String(raw)}，可选 slow | fail | 500`,
      request_id: String(req.id),
      retryable: false,
    });
  });
}
