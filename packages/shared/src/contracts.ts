/**
 * 契约 JSON Schema 生成（供 scripts 导出、Python 侧契约测试使用）
 *
 * 放在 shared 内部而不是脚本里，是因为 zod-to-json-schema 依赖必须从 shared 解析；
 * 这样调用方（gateway/scripts）无需重复声明该依赖。
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import {
  CreateTicketInputSchema,
  CreateTicketOutputSchema,
  QueryInventoryInputSchema,
  QueryInventoryOutputSchema,
  QueryOrderInputSchema,
  QueryOrderOutputSchema,
  SearchKnowledgeInputSchema,
  SearchKnowledgeOutputSchema,
} from './schemas.js';
import { ERROR_HTTP_STATUS, ERROR_CODES } from './errors.js';
import { SSE_EVENT_NAMES } from './sse.js';

export function buildContractSchemas(): Record<string, unknown> {
  const entries: Array<[string, ZodTypeAny]> = [
    ['query_inventory.input', QueryInventoryInputSchema],
    ['query_inventory.output', QueryInventoryOutputSchema],
    ['query_order.input', QueryOrderInputSchema],
    ['query_order.output', QueryOrderOutputSchema],
    ['create_ticket.input', CreateTicketInputSchema],
    ['create_ticket.output', CreateTicketOutputSchema],
    ['search_knowledge.input', SearchKnowledgeInputSchema],
    ['search_knowledge.output', SearchKnowledgeOutputSchema],
  ];

  const out: Record<string, unknown> = {};
  for (const [name, schema] of entries) {
    out[name] = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });
  }
  return out;
}

export const CONTRACT_MANIFEST = {
  sse_events: SSE_EVENT_NAMES,
  error_codes: ERROR_CODES.map((code) => ({ code, http_status: ERROR_HTTP_STATUS[code] })),
};
