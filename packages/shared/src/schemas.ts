/**
 * 工具契约（对应路线规划 2.3「工具清单」与「关键契约细节」，P0 冻结项）
 *
 * 单一真源：网关的工具注册表、business-api 的请求校验、前端类型、
 * 以及 contracts/*.schema.json（导出给 Python 侧做契约测试）全部从这里派生。
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 基础枚举与标量
 * ------------------------------------------------------------------ */

export const SkuSchema = z
  .string()
  .regex(/^SKU-[A-Z0-9]{6}$/, 'SKU 必须形如 SKU-A1B2C3（SKU- 加 6 位大写字母或数字）');

export const WarehouseCodeSchema = z.enum(['WH-SZ', 'WH-GZ', 'WH-SH']);

export const OrderStatusSchema = z.enum([
  'CREATED',
  'PAID',
  'PICKING',
  'SHIPPED',
  'DELIVERED',
  'CLOSED',
  'REFUNDING',
]);

export const TicketCategorySchema = z.enum(['LOGISTICS', 'QUALITY', 'RETURN', 'INVOICE', 'OTHER']);

export const TicketSeveritySchema = z.enum(['S2', 'S3', 'S4']);

export const DocTypeSchema = z.enum(['product_manual', 'faq', 'policy', 'wiki']);

export const BoundarySchema = z.enum(['in_kb', 'insufficient', 'out_of_scope']);

export const OrderNoSchema = z.string().regex(/^SO-\d{8}-\d{3}$/, '订单号形如 SO-20261012-007');

export const CustomerIdSchema = z.string().regex(/^C-\d{5}$/, '客户号形如 C-10087');

/** 金额：以「元」为单位、两位小数；服务端内部按「分」整数计算后再落库，避免浮点误差 */
export const MoneySchema = z.number().multipleOf(0.01);

/* ------------------------------------------------------------------ *
 * T1 query_inventory（读）
 * ------------------------------------------------------------------ */

export const QueryInventoryInputSchema = z
  .object({
    sku: SkuSchema,
    warehouse_code: WarehouseCodeSchema.optional(),
    /** 默认 true：可用量扣除预占；false 时按「在库口径」返回（quantity_basis=on_hand） */
    include_reserved: z.boolean().optional().default(true),
  })
  .strict();

export const SubstituteSchema = z.object({
  sku: SkuSchema,
  name: z.string(),
  available: z.number().int(),
  compatibility: z.enum(['direct', 'similar', 'upgrade']),
});

export const WarehouseStockSchema = z.object({
  warehouse: WarehouseCodeSchema,
  on_hand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
});

export const QueryInventoryOutputSchema = z.object({
  sku: SkuSchema,
  name: z.string(),
  /** 省略 warehouse_code 时为 'ALL'（跨仓汇总，D2 用例） */
  warehouse: z.union([WarehouseCodeSchema, z.literal('ALL')]),
  on_hand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  safety_stock: z.number().int(),
  below_safety: z.boolean(),
  in_transit: z.number().int(),
  restock_eta: z.string().nullable(),
  substitutes: z.array(SubstituteSchema),
  /** 契约扩展（附加字段，不破坏原契约）：跨仓明细，仅 warehouse=ALL 时返回 */
  by_warehouse: z.array(WarehouseStockSchema).optional(),
  /** 契约扩展：本次可用量的计算口径 */
  quantity_basis: z.enum(['available', 'on_hand']).optional(),
});

/* ------------------------------------------------------------------ *
 * T2 query_order（读，customer_id 由网关注入，模型无权传入）
 * ------------------------------------------------------------------ */

export const QueryOrderInputSchema = z
  .object({
    order_no: OrderNoSchema.optional(),
    phone_tail: z
      .string()
      .regex(/^[0-9]{4}$/, '手机尾号必须是 4 位数字')
      .optional(),
  })
  .strict()
  .refine((v) => Boolean(v.order_no) || Boolean(v.phone_tail), {
    message: 'order_no 与 phone_tail 至少提供一个',
    path: ['order_no'],
  });

export const OrderLineSchema = z.object({
  sku: SkuSchema,
  name: z.string(),
  qty: z.number().int().positive(),
  shipped_qty: z.number().int().nonnegative(),
  unit_price: MoneySchema,
});

export const OrderAmountsSchema = z.object({
  goods: MoneySchema,
  discount: MoneySchema,
  freight: MoneySchema,
  payable: MoneySchema,
});

export const ShipmentSchema = z.object({
  carrier: z.string(),
  tracking_no: z.string(),
  eta: z.string().nullable(),
});

export const QueryOrderOutputSchema = z.object({
  order_no: OrderNoSchema,
  status: OrderStatusSchema,
  lines: z.array(OrderLineSchema),
  amounts: OrderAmountsSchema,
  shipment: ShipmentSchema.optional(),
  ticket_ids: z.array(z.string()),
  /** 契约扩展：phone_tail 命中多单时给出候选，主体返回最近一单 */
  ambiguous: z.boolean().optional(),
  candidates: z.array(z.string()).optional(),
});

/* ------------------------------------------------------------------ *
 * T3 create_ticket（写：幂等键 + 冲突检测 + 限流）
 * ------------------------------------------------------------------ */

export const CreateTicketInputSchema = z
  .object({
    category: TicketCategorySchema,
    severity: TicketSeveritySchema,
    summary: z.string().min(20, '摘要至少 20 字').max(200, '摘要最多 200 字'),
    order_no: OrderNoSchema.optional(),
    sku: SkuSchema.optional(),
    /** 由网关按 (conversation_id + order_no + category) 派生并注入，模型不可见 */
    idempotency_key: z.string().uuid('idempotency_key 必须是 UUID'),
  })
  .strict();

export const CreateTicketOutputSchema = z.object({
  ticket_no: z.string().regex(/^TK-\d{8}-\d{4}$/),
  deduplicated: z.boolean(),
  sla_due_at: z.string(),
  owner_group: z.string(),
});

/* ------------------------------------------------------------------ *
 * T4 search_knowledge（读，RAG 内嵌；模块本身仍是独立服务）
 * ------------------------------------------------------------------ */

export const SearchKnowledgeInputSchema = z
  .object({
    question: z.string().min(3, '问题至少 3 字').max(500, '问题最多 500 字'),
    top_k: z.number().int().min(1).max(8).optional().default(4),
    filters: z
      .object({
        doc_type: DocTypeSchema.optional(),
        product_line: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SourceSchema = z.object({
  doc_id: z.string(),
  doc_title: z.string(),
  section: z.string(),
  chunk_id: z.string(),
  page: z.number().int().nullish(),
  score: z.number(),
  /** 契约扩展：引用原文片段，供前端展开 */
  text: z.string().optional(),
});

export const SearchKnowledgeOutputSchema = z.object({
  answer: z.string(),
  sources: z.array(SourceSchema),
  boundary: BoundarySchema,
  confidence: z.number().min(0).max(1),
  /** 状态图节点流转（route → rewrite → retrieve …），供前端透出与离线复查 */
  trace: z.array(z.string()).optional(),
});

/* ------------------------------------------------------------------ *
 * 类型导出
 * ------------------------------------------------------------------ */

export type Sku = z.infer<typeof SkuSchema>;
export type WarehouseCode = z.infer<typeof WarehouseCodeSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type TicketCategory = z.infer<typeof TicketCategorySchema>;
export type TicketSeverity = z.infer<typeof TicketSeveritySchema>;
export type DocType = z.infer<typeof DocTypeSchema>;
export type Boundary = z.infer<typeof BoundarySchema>;

export type QueryInventoryInput = z.infer<typeof QueryInventoryInputSchema>;
export type QueryInventoryOutput = z.infer<typeof QueryInventoryOutputSchema>;
export type QueryOrderInput = z.infer<typeof QueryOrderInputSchema>;
export type QueryOrderOutput = z.infer<typeof QueryOrderOutputSchema>;
export type CreateTicketInput = z.infer<typeof CreateTicketInputSchema>;
export type CreateTicketOutput = z.infer<typeof CreateTicketOutputSchema>;
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInputSchema>;
export type SearchKnowledgeOutput = z.infer<typeof SearchKnowledgeOutputSchema>;
export type Source = z.infer<typeof SourceSchema>;
