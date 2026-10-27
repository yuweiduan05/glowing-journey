/**
 * gateway 入口（:8081）
 * 独立启动：pnpm --filter @app/gateway dev
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { AppError, normalizeError } from '@app/shared';
import { config } from './env.js';
import { ModelChain } from './chain.js';
import { MockProvider } from './providers/mock.js';
import { OpenAIProvider } from './providers/openai.js';
import { ToolRegistry } from './tools/registry.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerHealthRoutes } from './routes/health.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  // 带附件时请求体包含文件正文（单文件上限 2 万字符，最多 4 个），
  // 1MB 对中文会不够用；8MB 足够且仍能挡住恶意大包。
  bodyLimit: 8 * 1024 * 1024,
});

await app.register(cors, {
  origin: true,
  credentials: true,
  exposedHeaders: ['x-request-id'],
});

// ---- 模型供应商：mock 兜底 / openai 兼容真实供应商 ----
const primary =
  config.model.provider === 'openai'
    ? new OpenAIProvider({
        apiKey: config.model.apiKey,
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        timeoutMs: config.model.timeoutMs,
        label: config.model.model,
      })
    : new MockProvider();

const fallback =
  config.model.provider === 'openai' && config.fallbackModel.apiKey && config.fallbackModel.baseUrl
    ? new OpenAIProvider({
        apiKey: config.fallbackModel.apiKey,
        baseUrl: config.fallbackModel.baseUrl,
        model: config.fallbackModel.model || config.model.model,
        timeoutMs: config.model.timeoutMs,
        label: config.fallbackModel.model || 'fallback',
      })
    : undefined;

const chain = new ModelChain(primary, fallback, {
  maxRetries: config.proxy.maxRetries,
  retryBaseMs: config.proxy.retryBaseMs,
  circuitThreshold: config.proxy.circuitThreshold,
  circuitCooldownMs: config.proxy.circuitCooldownMs,
});

const registry = new ToolRegistry({
  businessBaseUrl: config.businessBaseUrl,
  ragBaseUrl: config.ragBaseUrl,
  toolTimeoutMs: config.toolTimeoutMs,
  ragTimeoutMs: config.ragTimeoutMs,
});

const modelLabel = primary.name;

// ---- 统一错误收口（ADR-005）----
app.setErrorHandler((err, req, reply) => {
  const appErr = normalizeError(err);
  req.log.warn({ code: appErr.code, msg: appErr.message }, 'request failed');
  if (reply.raw.headersSent) {
    reply.raw.end();
    return;
  }
  void reply.status(appErr.httpStatus).send(appErr.toEnvelope(String(req.id)));
});

app.setNotFoundHandler((req, reply) => {
  const err = new AppError('NOT_FOUND', { message: `路由不存在：${req.method} ${req.url}` });
  void reply.status(404).send(err.toEnvelope(String(req.id)));
});

registerHealthRoutes(app, modelLabel);
registerChatRoutes(app, { chain, registry, modelLabel });

try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(
    `[gateway] http://127.0.0.1:${config.port}  provider=${config.model.provider}(${modelLabel})  ` +
      `business=${config.businessBaseUrl}  rag=${config.ragBaseUrl}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
