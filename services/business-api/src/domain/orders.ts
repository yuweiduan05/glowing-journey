/**
 * T2 业务规则（对应 2.2 数据边界：customer_id 由网关注入，模型无权指定）
 *
 * 越权语义：订单存在但不属于当前客户 → 403 FORBIDDEN_DATA_SCOPE；
 * 订单不存在 → 404 NOT_FOUND。两类错误必须分开，否则前端无法区分「查不到」和「不能查」。
 */
import { AppError } from '@app/shared';
import type { OrderStatus, QueryOrderInput, QueryOrderOutput } from '@app/shared';
import type { Database } from '../db.js';

interface OrderRow {
  order_no: string;
  customer_id: string;
  status: string;
  goods_cents: number;
  discount_cents: number;
  freight_cents: number;
  payable_cents: number;
  carrier: string | null;
  tracking_no: string | null;
  eta: string | null;
}

interface LineRow {
  sku: string;
  name: string;
  qty: number;
  shipped_qty: number;
  unit_price_cents: number;
}

const cents = (c: number) => Math.round(c) / 100;

function toOutput(db: Database, row: OrderRow): QueryOrderOutput {
  const lines = db
    .prepare(
      `SELECT ol.sku, p.name, ol.qty, ol.shipped_qty, ol.unit_price_cents
         FROM order_lines ol JOIN products p ON p.sku = ol.sku
        WHERE ol.order_no = ? ORDER BY ol.id`,
    )
    .all(row.order_no) as LineRow[];

  const tickets = db
    .prepare('SELECT ticket_no FROM tickets WHERE order_no = ? ORDER BY created_at DESC')
    .all(row.order_no) as Array<{ ticket_no: string }>;

  const out: QueryOrderOutput = {
    order_no: row.order_no,
    status: row.status as OrderStatus,
    lines: lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      shipped_qty: l.shipped_qty,
      unit_price: cents(l.unit_price_cents),
    })),
    amounts: {
      goods: cents(row.goods_cents),
      discount: cents(row.discount_cents),
      freight: cents(row.freight_cents),
      payable: cents(row.payable_cents),
    },
    ticket_ids: tickets.map((t) => t.ticket_no),
  };

  if (row.carrier && row.tracking_no) {
    out.shipment = { carrier: row.carrier, tracking_no: row.tracking_no, eta: row.eta };
  }

  return out;
}

export function queryOrder(
  db: Database,
  input: QueryOrderInput,
  customerId: string,
): QueryOrderOutput {
  if (input.order_no) {
    const row = db
      .prepare(
        `SELECT order_no, customer_id, status, goods_cents, discount_cents, freight_cents,
                payable_cents, carrier, tracking_no, eta
           FROM orders WHERE order_no = ?`,
      )
      .get(input.order_no) as (OrderRow & { customer_id: string }) | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', {
        message: `订单 ${input.order_no} 不存在`,
        details: [{ path: '/order_no', message: '未找到该订单', code: 'unknown_order' }],
      });
    }

    if (row.customer_id !== customerId) {
      throw new AppError('FORBIDDEN_DATA_SCOPE', {
        message: '无权查看其他客户的订单数据',
        details: [{ path: '/order_no', message: '订单不属于当前登录客户', code: 'out_of_scope' }],
      });
    }

    return toOutput(db, row);
  }

  // phone_tail：只在当前客户名下检索（customer_id 由网关注入，不接受模型传入）
  const rows = db
    .prepare(
      `SELECT o.order_no, o.customer_id, o.status, o.goods_cents, o.discount_cents, o.freight_cents,
              o.payable_cents, o.carrier, o.tracking_no, o.eta, o.created_at
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.customer_id = ? AND c.phone_tail = ?
        ORDER BY o.created_at DESC`,
    )
    .all(customerId, input.phone_tail ?? '') as Array<OrderRow & { created_at: string }>;

  if (rows.length === 0) {
    throw new AppError('NOT_FOUND', {
      message: `当前客户名下没有尾号 ${input.phone_tail} 的订单`,
      details: [{ path: '/phone_tail', message: '未匹配到订单', code: 'unknown_order' }],
    });
  }

  const latest = rows[0]!;
  const out = toOutput(db, latest);
  if (rows.length > 1) {
    out.ambiguous = true;
    out.candidates = rows.slice(0, 5).map((r) => r.order_no);
  }
  return out;
}
