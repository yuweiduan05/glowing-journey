import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(SERVICE_DIR, '../..');

/** 读取仓库根目录 .env（不存在则忽略），显式传入的环境变量优先 */
export function loadEnv(): void {
  const envPath = path.join(REPO_DIR, '.env');
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      /* .env 格式异常不应阻塞启动 */
    }
  }
}

// 先加载根 .env 再构造 config：ESM 下本模块先于 server.ts 求值，
// 若只在 server.ts 里调 loadEnv()，下面这些 BUSINESS_* 变量会静默失效
// （R2 审查 P1-C：cp .env.example .env 的标准工作流少一半可配置性）。
loadEnv();

function resolveFromService(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(SERVICE_DIR, p);
}

export const config = {
  port: Number(process.env.BUSINESS_API_PORT ?? 8082),
  dbPath: resolveFromService(process.env.BUSINESS_DB_PATH ?? './data/business.db'),
  seedOnBoot: (process.env.BUSINESS_SEED ?? '1') !== '0',
  // 故障注入总开关：默认关（安全默认，避免误部署后一个 ?chaos=500 打死服务）；
  // 演示/联调 profile 显式开启——本仓库的 `pnpm dev`（dev:business）就是显式开的。
  chaosEnabled: (process.env.BUSINESS_CHAOS_ENABLED ?? '0') !== '0',
  ticketRateLimit: Number(process.env.TICKET_RATE_LIMIT ?? 5),
  ticketRateWindowMs: Number(process.env.TICKET_RATE_WINDOW_MS ?? 60_000),
};
