/**
 * 真实模型演练（MODEL_PROVIDER=openai）
 *
 * 为什么需要它：`providers/openai.ts` 里最容易被写错的三处——tool_calls 增量拼接、
 * reasoning_content 解析、超时/连接失败的错误映射——在 mock 模式下永远不会被执行。
 * 这个脚本把这些路径单独拎出来跑一遍，答辩前 1 分钟就能知道"换真模型会不会炸"。
 *
 * 用法：
 *   pnpm drill:model                          # 不花钱：只验证失败路径（缺 Key / 上游不可达）
 *   pnpm drill:model -- --gateway             # 额外验证运行中的网关（需网关已切真实模型）
 *   MODEL_API_KEY=sk-... MODEL_BASE_URL=https://api.deepseek.com/v1 \
 *   MODEL_NAME=deepseek-chat pnpm drill:model # 完整演练
 *
 * 推理模型（deepseek-reasoner / o1 / r1）会额外检查 reasoning 增量；
 * 普通模型自动跳过该项，不算失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, toOpenAITools } from '@app/shared';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { ModelChunk, ModelRequest } from '../src/providers/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8081';

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';

interface Row {
  name: string;
  status: Status;
  detail: string;
  ms?: number;
}

const rows: Row[] = [];
const add = (row: Row) => {
  rows.push(row);
  console.log(`${row.status.padEnd(4)} ${row.name.padEnd(26)} ${row.detail}`);
};

/** 读取 .env，但不覆盖命令行已显式传入的变量 */
function loadEnvFile(): void {
  const file = path.join(REPO, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (!key || process.env[key] !== undefined) continue;
    let value = raw ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function mask(key: string): string {
  if (!key) return '(未设置)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function describeError(err: unknown): string {
  if (err instanceof AppError) return `${err.code}：${err.message}`;
  return (err as Error)?.message ?? String(err);
}

interface Collected {
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  reasoningChars: number;
  firstTextMs: number | null;
  totalMs: number;
}

async function collect(
  provider: OpenAIProvider,
  req: ModelRequest,
  timeoutMs: number,
): Promise<Collected> {
  const started = performance.now();
  let text = '';
  let reasoningChars = 0;
  let firstTextMs: number | null = null;
  let toolCalls: Collected['toolCalls'] = [];

  for await (const chunk of provider.stream(req, AbortSignal.timeout(timeoutMs))) {
    if (chunk.type === 'text') {
      if (firstTextMs === null) firstTextMs = performance.now() - started;
      text += chunk.delta;
    } else if (chunk.type === 'reasoning') {
      reasoningChars += chunk.delta.length;
    } else {
      toolCalls = chunk.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
    }
  }

  return { text, toolCalls, reasoningChars, firstTextMs, totalMs: performance.now() - started };
}

function providerFor(apiKey: string, baseUrl: string, model: string, timeoutMs: number) {
  return new OpenAIProvider({ apiKey, baseUrl, model, timeoutMs, label: model });
}

async function runFailurePaths(cfg: {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): Promise<void> {
  // 1) 缺 Key：必须在发请求前就拒绝，不能等到上游 401
  try {
    const p = providerFor('', cfg.baseUrl, cfg.model, 3000);
    await collect(p, { messages: [{ role: 'user', content: 'ping' }], tools: [] }, 3000);
    add({ name: '失败路径 · 缺少 Key', status: 'FAIL', detail: '没有抛错，空 Key 被放行了' });
  } catch (err) {
    const ok = err instanceof AppError && err.code === 'UNAUTHORIZED';
    add({
      name: '失败路径 · 缺少 Key',
      status: ok ? 'PASS' : 'FAIL',
      detail: describeError(err),
    });
  }

  // 2) 上游不可达：要映射成 UPSTREAM_MODEL_ERROR，而不是裸 fetch 异常
  const started = performance.now();
  try {
    const p = providerFor('drill-key', 'http://127.0.0.1:9/v1', cfg.model, 2500);
    await collect(p, { messages: [{ role: 'user', content: 'ping' }], tools: [] }, 4000);
    add({
      name: '失败路径 · 上游不可达',
      status: 'FAIL',
      detail: '没有抛错，连接失败被吞掉了',
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    const ok = err instanceof AppError && err.code === 'UPSTREAM_MODEL_ERROR';
    add({
      name: '失败路径 · 上游不可达',
      status: ok ? 'PASS' : 'FAIL',
      detail: describeError(err),
      ms: Math.round(performance.now() - started),
    });
  }
}

async function runWithKey(cfg: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): Promise<void> {
  // 3) 文本流式：首 token 延迟是前端「首包耗时」的真实来源
  try {
    const p = providerFor(cfg.apiKey, cfg.baseUrl, cfg.model, cfg.timeoutMs);
    const res = await collect(
      p,
      {
        messages: [
          { role: 'system', content: '你是简洁的助手，只按要求回答。' },
          { role: 'user', content: '只回复两个字：收到' },
        ],
        tools: [],
        temperature: 0,
      },
      cfg.timeoutMs,
    );
    const ok = res.text.trim().length > 0;
    add({
      name: '文本流式',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `首 token ${Math.round(res.firstTextMs ?? res.totalMs)}ms，全文 ${res.text.trim().slice(0, 24)}`
        : '没有收到任何文本增量',
      ms: Math.round(res.totalMs),
    });
  } catch (err) {
    add({ name: '文本流式', status: 'FAIL', detail: describeError(err) });
  }

  // 4) 工具调用：验证增量 tool_calls 能被正确拼成完整 JSON
  try {
    const tools = toOpenAITools().filter((t) => t.function.name === 'query_inventory');
    const p = providerFor(cfg.apiKey, cfg.baseUrl, cfg.model, cfg.timeoutMs);
    const res = await collect(
      p,
      {
        messages: [
          {
            role: 'system',
            content: '你是业务助手。库存问题必须调用 query_inventory，不要编造数字。',
          },
          { role: 'user', content: '深圳仓 SKU-A1B2C3 还有多少可用库存？' },
        ],
        tools,
        temperature: 0,
      },
      cfg.timeoutMs,
    );

    const call = res.toolCalls[0];
    if (!call) {
      add({
        name: '工具调用（tool_calls）',
        status: 'WARN',
        detail: '模型没有发起工具调用，可能不支持 function calling',
        ms: Math.round(res.totalMs),
      });
      return;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      add({
        name: '工具调用（tool_calls）',
        status: 'FAIL',
        detail: `arguments 不是合法 JSON：${call.arguments.slice(0, 80)}`,
        ms: Math.round(res.totalMs),
      });
      return;
    }

    const ok = call.name === 'query_inventory' && typeof parsed.sku === 'string';
    add({
      name: '工具调用（tool_calls）',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `${call.name}(${String(parsed.sku)}${parsed.warehouse_code ? `, ${String(parsed.warehouse_code)}` : ''})`
        : `调用了 ${call.name}，参数缺少 sku`,
      ms: Math.round(res.totalMs),
    });
  } catch (err) {
    add({ name: '工具调用（tool_calls）', status: 'FAIL', detail: describeError(err) });
  }

  // 5) 思考增量：推理模型才有，普通模型跳过
  const isReasoningModel = /reasoner|r1|thinking|o1|o3/i.test(cfg.model);
  if (!isReasoningModel) {
    add({
      name: '思考增量（reasoning）',
      status: 'SKIP',
      detail: `${cfg.model} 不是推理模型；要看灰字思考请用 deepseek-reasoner 等`,
    });
  } else {
    try {
      const p = providerFor(cfg.apiKey, cfg.baseUrl, cfg.model, Math.max(cfg.timeoutMs, 60_000));
      const res = await collect(
        p,
        {
          messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？只回答结论。' }],
          tools: [],
        },
        Math.max(cfg.timeoutMs, 60_000),
      );
      add({
        name: '思考增量（reasoning）',
        status: res.reasoningChars > 0 ? 'PASS' : 'WARN',
        detail:
          res.reasoningChars > 0
            ? `收到 ${res.reasoningChars} 字思考增量，答案：${res.text.trim().slice(0, 20)}`
            : '没有 reasoning_content；确认模型名是否真的支持思考模式',
        ms: Math.round(res.totalMs),
      });
    } catch (err) {
      add({ name: '思考增量（reasoning）', status: 'FAIL', detail: describeError(err) });
    }
  }
}

async function gatewayCall(body: unknown, query = ''): Promise<{ status: number; json: any }> {
  const token = (process.env.AUTH_TOKENS ?? 'demo-token:C-10087').split(',')[0]?.split(':')[0] ?? '';
  const res = await fetch(`${GATEWAY}/v1/chat/completions${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function runGateway(): Promise<void> {
  const health = await fetch(`${GATEWAY}/health`).then((r) => r.json() as Promise<any>);
  const modelCheck = health?.checks?.['model-provider'];
  add({
    name: '网关 · 模型健康',
    status: modelCheck?.status === 'ok' ? 'PASS' : 'FAIL',
    detail: `${modelCheck?.status ?? 'unknown'}｜${modelCheck?.detail ?? ''}`,
  });

  const ask = (content: string, chaos = '') =>
    gatewayCall(
      { messages: [{ role: 'user', content }], stream: false },
      chaos ? `?chaos=${chaos}` : '',
    );

  try {
    const started = performance.now();
    const { json } = await ask('深圳仓 SKU-A1B2C3 还有多少可用库存？');
    const content = String(json?.choices?.[0]?.message?.content ?? '');
    const ok = content.includes('17');
    add({
      name: '网关 · D1 库存',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? content.split('\n')[0]!.slice(0, 60) : `回答里没出现可用量：${content.slice(0, 60)}`,
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    add({ name: '网关 · D1 库存', status: 'FAIL', detail: describeError(err) });
  }

  try {
    const started = performance.now();
    const { json } = await ask('这款设备的保修期是多久？换货要什么条件？');
    const content = String(json?.choices?.[0]?.message?.content ?? '');
    const citations = json?.citations ?? [];
    const ok = content.length > 0 && citations.length > 0;
    add({
      name: '网关 · D5 知识问答',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `引用 ${citations.length} 条，首句：${content.split('\n')[0]!.slice(0, 48)}`
        : `引用 ${citations.length} 条，回答长度 ${content.length}`,
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    add({ name: '网关 · D5 知识问答', status: 'FAIL', detail: describeError(err) });
  }

  try {
    const started = performance.now();
    const { json } = await ask('深圳仓 SKU-A1B2C3 还有多少可用库存？', '500');
    const timeline: any[] = json?.timeline ?? [];
    const failed = timeline.find((t) => t.kind === 'tool' && t.status === 'error');
    const ok = failed?.error?.code === 'TOOL_UPSTREAM_ERROR';
    add({
      name: '网关 · D8 故障注入',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `${failed.error.code}（前端可提示重试）`
        : '未捕获工具失败；业务服务是否以 BUSINESS_CHAOS_ENABLED=1 启动？',
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    add({ name: '网关 · D8 故障注入', status: 'FAIL', detail: describeError(err) });
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const cfg = {
    apiKey: process.env.MODEL_API_KEY ?? '',
    baseUrl: (process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.MODEL_NAME ?? 'gpt-4o-mini',
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? 30_000),
  };
  const withGateway = process.argv.includes('--gateway');

  console.log(`模型：${cfg.model}`);
  console.log(`地址：${cfg.baseUrl}`);
  console.log(`Key ：${mask(cfg.apiKey)}`);
  console.log('─'.repeat(72));

  await runFailurePaths(cfg);

  if (cfg.apiKey) {
    await runWithKey(cfg);
  } else {
    add({
      name: '文本 / 工具 / 思考',
      status: 'SKIP',
      detail: '未配置 MODEL_API_KEY，跳过需要真实调用的用例',
    });
  }

  if (withGateway) {
    await runGateway();
  }

  const passed = rows.filter((r) => r.status === 'PASS').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const warned = rows.filter((r) => r.status === 'WARN').length;
  const skipped = rows.filter((r) => r.status === 'SKIP').length;

  console.log('─'.repeat(72));
  console.log(`PASS ${passed} · FAIL ${failed} · WARN ${warned} · SKIP ${skipped}`);

  if (!cfg.apiKey) {
    console.log('\n下一步：在 .env 里填 MODEL_PROVIDER=openai / MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME，');
    console.log('然后重新执行 pnpm drill:model；网关要一起验证就加 -- --gateway。');
  } else if (failed === 0) {
    console.log('\n真实模型路径已跑通。把网关切到 openai 后，用 -- --gateway 再验一次端到端。');
  }

  const reportDir = path.join(REPO, 'data/runtime');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, 'model-drill.json'),
    `${JSON.stringify(
      {
        ts: new Date().toISOString(),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        keyMasked: mask(cfg.apiKey),
        gatewayChecked: withGateway,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`报告：data/runtime/model-drill.json`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('演练脚本自身出错：', err);
  process.exit(2);
});
