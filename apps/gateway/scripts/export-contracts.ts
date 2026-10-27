/**
 * 契约导出：把 packages/shared 里的 zod schema 落成 JSON Schema 到 contracts/，
 * 供 Python 侧（Pydantic）做契约测试 —— TS 无法直接 import 到 Python，
 * 用「同一份 schema + 双向校验」代替含糊的口头约定。
 *
 * 运行：pnpm contracts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContractSchemas, CONTRACT_MANIFEST } from '@app/shared';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(repo, 'contracts');
mkdirSync(outDir, { recursive: true });

const schemas = buildContractSchemas();
for (const [name, json] of Object.entries(schemas)) {
  writeFileSync(path.join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n', 'utf8');
}

writeFileSync(
  path.join(outDir, 'sse-events.json'),
  JSON.stringify(
    CONTRACT_MANIFEST.sse_events.map((event) => ({ event, direction: 'server->client' })),
    null,
    2,
  ) + '\n',
  'utf8',
);

writeFileSync(
  path.join(outDir, 'error-codes.json'),
  JSON.stringify(CONTRACT_MANIFEST.error_codes, null, 2) + '\n',
  'utf8',
);

console.log(`[contracts] 已导出 ${Object.keys(schemas).length} 份 schema + SSE/错误码清单 → ${outDir}`);
