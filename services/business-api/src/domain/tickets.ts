/**
 * T3 业务规则（对应 2.3「写工具必须有幂等键 + 冲突检测 + 人工确认提示」）
 *
 * 三层健壮性：
 * 1. 幂等：idempotency_key 唯一索引；重放直接返回同一 ticket_no 且 deduplicated=true；
 * 2. 冲突：同订单同类别存在未关闭工单 → 409 DUPLICATE_TICKET，并把已有工单号放进 details；
 * 3. 限流：单客户 5 单/分钟，超出 → 429 RATE_LIMITED。
 */
import { AppError } from '@app/shared';
import type { CreateTicketInput, CreateTicketOutput } from '@app/shared';
import type { Database } from '../db.js';

const OWNER_GROUP: Record<string, string> = {
  LOGISTICS: '售后物流组',
  QUALITY: '质量工程组',
  RETURN: '退货处理组',
  INVOICE: '财务结算组',
  OTHER: '一线客服组',
};

/** S2 4 小时 / S3 24 小时 / S4 72 小时 */
const SLA_HOURS: Record<string, number> = { S2: 4, S3: 24, S4: 72 };

/** 归一化：只保留中文/字母/数字，用于摘要相似度比较 */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
    .toLowerCase();
}

function bigrams(text: string): Set<string> {
  const norm = normalizeText(text);
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 1; i += 1) out.add(norm.slice(i, i + 2));
  return out;
}

/** 字符 2-gram Jaccard；同一句话换标点/空格会被归一化后判为 1.0 */
function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

interface TicketRow {
  ticket_no: string;
  customer_id: string;
  status: string;
  sla_due_at: string;
  owner_group: string;
  deduplicated?: number;
}

/** 工单详情（与 tickets 表字段一一对应） */
export interface TicketDetail {
  ticket_no: string;
  customer_id: string;
  category: string;
  severity: string;
  summary: string;
  order_no: string | null;
  sku: string | null;
  status: string;
  owner_group: string;
  sla_due_at: string;
  created_at: string;
}

function todayStamp(now: Date): string {
  // 以 Asia/Shanghai 为准，避免跨时区把工单日期算错
  const shanghai = new Date(now.getTime() + 8 * 3600_000);
  return `${shanghai.getUTCFullYear()}${String(shanghai.getUTCMonth() + 1).padStart(2, '0')}${String(
    shanghai.getUTCDate(),
  ).padStart(2, '0')}`;
}

export class TicketService {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly db: Database,
    private readonly rateLimit = 5,
    private readonly rateWindowMs = 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateTicketInput, customerId: string): CreateTicketOutput {
    // 1) 幂等重放：同一 key 直接命中已有工单
    const replay = this.db
      .prepare(
        'SELECT ticket_no, customer_id, status, sla_due_at, owner_group FROM tickets WHERE idempotency_key = ?',
      )
      .get(input.idempotency_key) as TicketRow | undefined;

    if (replay) {
      if (replay.customer_id !== customerId) {
        throw new AppError('FORBIDDEN_DATA_SCOPE', {
          message: '该工单不属于当前客户',
          details: [{ path: '/idempotency_key', message: '跨客户重放被拒绝', code: 'out_of_scope' }],
        });
      }
      return {
        ticket_no: replay.ticket_no,
        deduplicated: true,
        sla_due_at: replay.sla_due_at,
        owner_group: replay.owner_group,
      };
    }

    // 2) 关联订单必须属于当前客户
    if (input.order_no) {
      const order = this.db
        .prepare('SELECT customer_id, status FROM orders WHERE order_no = ?')
        .get(input.order_no) as { customer_id: string; status: string } | undefined;

      if (!order) {
        throw new AppError('NOT_FOUND', {
          message: `订单 ${input.order_no} 不存在`,
          details: [{ path: '/order_no', message: '未找到该订单', code: 'unknown_order' }],
        });
      }
      if (order.customer_id !== customerId) {
        throw new AppError('FORBIDDEN_DATA_SCOPE', {
          message: '不能为其他客户的订单建工单',
          details: [{ path: '/order_no', message: '订单不属于当前登录客户', code: 'out_of_scope' }],
        });
      }
    }

    // 3) 冲突检测：同订单 + 同类别 + **摘要高度相似** 才算重复。
    //    只看类别会把「少发」和「外箱破损」折叠成一张单，导致漏单。
    if (input.order_no) {
      const openTickets = this.db
        .prepare(
          `SELECT ticket_no, status, summary FROM tickets
            WHERE order_no = ? AND category = ? AND status <> 'CLOSED'
            ORDER BY created_at DESC`,
        )
        .all(input.order_no, input.category) as Array<{
        ticket_no: string;
        status: string;
        summary: string;
      }>;

      for (const ticket of openTickets) {
        if (similarity(ticket.summary, input.summary) >= 0.7) {
          throw new AppError('DUPLICATE_TICKET', {
            message: `该问题已有未关闭工单 ${ticket.ticket_no}，请在该工单上追加进展`,
            details: [
              {
                path: '/summary',
                message: `未关闭工单：${ticket.ticket_no}（${ticket.status}）`,
                code: 'duplicate_ticket',
              },
            ],
            retryable: false,
          });
        }
      }

      // 防滥用：同一订单同一类别最多 3 张未关闭工单（不同问题可以建，但不允许刷单）
      if (openTickets.length >= 3) {
        throw new AppError('DUPLICATE_TICKET', {
          message: `该订单该类别的未关闭工单已达 3 张，请先处理已有工单`,
          details: [
            {
              path: '/order_no',
              message: `未关闭工单：${openTickets.map((t) => t.ticket_no).join('、')}`,
              code: 'open_ticket_limit',
            },
          ],
          retryable: false,
        });
      }
    }

    // 4) 限流
    this.assertRateLimit(customerId);

    // 5) 落库（唯一索引兜底并发：抢到同一 idempotency_key 时回读）
    const now = this.now();
    const stamp = todayStamp(now);
    const slaDue = new Date(now.getTime() + (SLA_HOURS[input.severity] ?? 24) * 3600_000);
    const ownerGroup = OWNER_GROUP[input.category] ?? '一线客服组';

    try {
      this.db.exec('BEGIN IMMEDIATE');
      const countRow = this.db
        .prepare('SELECT COUNT(*) AS c FROM tickets WHERE ticket_no LIKE ?')
        .get(`TK-${stamp}-%`) as { c: number };
      const ticketNo = `TK-${stamp}-${String(countRow.c + 1).padStart(4, '0')}`;

      this.db
        .prepare(
          `INSERT INTO tickets (ticket_no, customer_id, category, severity, summary, order_no, sku,
             status, owner_group, sla_due_at, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        )
        .run(
          ticketNo,
          customerId,
          input.category,
          input.severity,
          input.summary,
          input.order_no ?? null,
          input.sku ?? null,
          ownerGroup,
          slaDue.toISOString(),
          input.idempotency_key,
          now.toISOString(),
        );

      this.db.exec('COMMIT');

      return {
        ticket_no: ticketNo,
        deduplicated: false,
        sla_due_at: slaDue.toISOString(),
        owner_group: ownerGroup,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      // 并发下同一 key 抢先落库：回读并返回 deduplicated=true
      const raced = this.db
        .prepare('SELECT ticket_no, customer_id, sla_due_at, owner_group FROM tickets WHERE idempotency_key = ?')
        .get(input.idempotency_key) as TicketRow | undefined;
      if (raced) {
        return {
          ticket_no: raced.ticket_no,
          deduplicated: true,
          sla_due_at: raced.sla_due_at,
          owner_group: raced.owner_group,
        };
      }
      throw new AppError('INTERNAL_ERROR', {
        message: '工单创建失败，请稍后重试',
        cause: err,
      });
    }
  }

  /**
   * 工单详情：与订单路径同样受 customer_id 边界约束——
   * customer_id 只能来自网关注入的 X-Customer-Id，越权读取返回 403（不是 404）。
   */
  get(ticketNo: string, customerId: string): TicketDetail {
    const row = this.db
      .prepare(
        `SELECT ticket_no, customer_id, category, severity, summary, order_no, sku, status,
                owner_group, sla_due_at, created_at FROM tickets WHERE ticket_no = ?`,
      )
      .get(ticketNo) as TicketDetail | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', {
        message: `工单 ${ticketNo} 不存在`,
        details: [{ path: '/ticket_no', message: '未找到该工单', code: 'unknown_ticket' }],
      });
    }
    if (row.customer_id !== customerId) {
      throw new AppError('FORBIDDEN_DATA_SCOPE', {
        message: '无权查看其他客户的工单数据',
        details: [{ path: '/ticket_no', message: '工单不属于当前登录客户', code: 'out_of_scope' }],
      });
    }
    return row;
  }

  private assertRateLimit(customerId: string): void {
    const now = this.now().getTime();
    const windowStart = now - this.rateWindowMs;
    const recent = (this.hits.get(customerId) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.rateLimit) {
      this.hits.set(customerId, recent);
      throw new AppError('RATE_LIMITED', {
        message: `建单过于频繁（${this.rateLimit} 单/分钟），请稍后重试`,
        retryable: true,
      });
    }
    recent.push(now);
    this.hits.set(customerId, recent);
  }
}
