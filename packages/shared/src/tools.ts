/**
 * 工具注册表契约（对应 2.3 工具清单 + 1.2「封装 2–3 个业务工具」）
 *
 * 两种入参 schema 的差别是本项目的关键工程点：
 * - inputSchema   ：工具服务端的完整契约（含 idempotency_key 等服务端注入字段）
 * - modelInputSchema：真正下发给模型的 JSON Schema（剔除服务端注入字段，
 *   模型看不到 idempotency_key，也就无法每次重放都换一个新 uuid）
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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

export const TOOL_NAMES = [
  'query_inventory',
  'query_order',
  'create_ticket',
  'search_knowledge',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** 服务端注入、模型不可见也不可传的字段 */
export const SERVER_INJECTED_FIELDS = {
  query_inventory: [],
  query_order: ['customer_id'],
  create_ticket: ['idempotency_key'],
  search_knowledge: [],
} as const satisfies Record<ToolName, readonly string[]>;

export interface ToolDefinition {
  name: ToolName;
  kind: 'read' | 'write';
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  modelInputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  serverInjected: readonly string[];
  /** OpenAI function calling 所需的 JSON Schema */
  parameters: Record<string, unknown>;
}

/** T3 的幂等键由网关派生注入，模型侧 schema 直接剔除该字段 */
const CreateTicketModelInputSchema = CreateTicketInputSchema.omit({ idempotency_key: true });

function build(
  def: Omit<ToolDefinition, 'parameters' | 'modelInputSchema'> & {
    modelInputSchema: z.ZodTypeAny;
  },
): ToolDefinition {
  return {
    ...def,
    parameters: zodToJsonSchema(def.modelInputSchema, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, unknown>,
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  build({
    name: 'query_inventory',
    kind: 'read',
    title: '查库存',
    description:
      '查询某个 SKU 的在库量、预占量、可用量、安全库存、在途量与替代型号。' +
      '售前问「还有货吗 / 深圳仓能今天发吗」、库存问「低于安全库存的有哪些」时使用。' +
      '不传 warehouse_code 表示跨三仓汇总。用户没有给出具体 SKU 时不要编造 SKU，先向用户确认型号。',
    inputSchema: QueryInventoryInputSchema,
    modelInputSchema: QueryInventoryInputSchema,
    outputSchema: QueryInventoryOutputSchema,
    serverInjected: [],
  }),
  build({
    name: 'query_order',
    kind: 'read',
    title: '查订单',
    description:
      '按订单号或收货人手机尾号查询订单状态、明细、金额、物流与关联工单。' +
      '售后问「订单到哪了 / 少发了一件」时先查订单。' +
      'customer_id 由服务端从会话上下文注入，禁止在参数中出现客户号。',
    inputSchema: QueryOrderInputSchema,
    modelInputSchema: QueryOrderInputSchema,
    outputSchema: QueryOrderOutputSchema,
    serverInjected: ['customer_id'],
  }),
  build({
    name: 'create_ticket',
    kind: 'write',
    title: '建工单',
    description:
      '为售后问题创建工单。summary 必须 20–200 字，写清「谁、哪单、什么问题、期望怎么处理」。' +
      '幂等键由服务端生成：同一会话同一订单同一类别重复调用会返回同一工单号并置 deduplicated=true' +
      '（键含摘要指纹——摘要不同的新问题不会与旧工单折叠）。' +
      '已发货订单不能改单，只能走售后工单。',
    inputSchema: CreateTicketInputSchema,
    modelInputSchema: CreateTicketModelInputSchema,
    outputSchema: CreateTicketOutputSchema,
    serverInjected: ['idempotency_key'],
  }),
  build({
    name: 'search_knowledge',
    kind: 'read',
    title: '查知识库',
    description:
      '检索企业知识库（产品手册 / FAQ / 政策条款 / Wiki），返回带出处的答案。' +
      '问保修政策、换货条件、参数规格、操作规范时使用。' +
      '返回 boundary=insufficient 表示知识库未覆盖，out_of_scope 表示超出业务范围，此时不要自行编造。',
    inputSchema: SearchKnowledgeInputSchema,
    modelInputSchema: SearchKnowledgeInputSchema,
    outputSchema: SearchKnowledgeOutputSchema,
    serverInjected: [],
  }),
];

export const TOOL_BY_NAME: Record<ToolName, ToolDefinition> = Object.fromEntries(
  TOOL_DEFINITIONS.map((t) => [t.name, t]),
) as Record<ToolName, ToolDefinition>;

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** 下发给 OpenAI 兼容上游的 tools 字段 */
export function toOpenAITools() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
