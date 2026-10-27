import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(SERVICE_DIR, '../..');

export function loadEnv(): void {
  const envPath = path.join(REPO_DIR, '.env');
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      /* ignore malformed .env */
    }
  }
}

loadEnv();

export interface ModelConfig {
  provider: 'mock' | 'openai';
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? 'demo-token:C-10087').split(',')) {
    const [token, customerId] = pair.split(':');
    if (token && customerId) map.set(token.trim(), customerId.trim());
  }
  return map;
}

export const config = {
  port: Number(process.env.GATEWAY_PORT ?? 8081),
  businessBaseUrl: process.env.BUSINESS_API_BASE_URL ?? 'http://127.0.0.1:8082',
  ragBaseUrl: process.env.RAG_BASE_URL ?? 'http://127.0.0.1:8083',
  ragTimeoutMs: Number(process.env.RAG_TIMEOUT_MS ?? 8000),
  toolTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS ?? 5000),
  defaultMaxToolRounds: 3,
  heartbeatMs: Number(process.env.SSE_HEARTBEAT_MS ?? 15_000),
  authTokens: parseTokens(process.env.AUTH_TOKENS),
  model: {
    provider: (process.env.MODEL_PROVIDER ?? 'mock') === 'openai' ? 'openai' : 'mock',
    apiKey: process.env.MODEL_API_KEY ?? '',
    baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.MODEL_NAME ?? 'gpt-4o-mini',
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? 30_000),
  } satisfies ModelConfig,
  fallbackModel: {
    apiKey: process.env.MODEL_FALLBACK_API_KEY ?? '',
    baseUrl: process.env.MODEL_FALLBACK_BASE_URL ?? '',
    model: process.env.MODEL_FALLBACK_NAME ?? '',
  },
  proxy: {
    maxRetries: Number(process.env.PROXY_MAX_RETRIES ?? 2),
    retryBaseMs: Number(process.env.PROXY_RETRY_BASE_MS ?? 300),
    circuitThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD ?? 5),
    circuitCooldownMs: Number(process.env.CIRCUIT_COOLDOWN_MS ?? 15_000),
  },
};
