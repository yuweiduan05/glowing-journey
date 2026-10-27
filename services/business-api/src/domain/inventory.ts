/**
 * T1 业务规则（对应 2.2「可用库存 ≠ 在库数量」）
 *
 * 核心语义：
 * - available = on_hand - reserved（预占要扣，未扣会把「有货」答错）
 * - include_reserved=false 时按「在库口径」返回，并在 quantity_basis 标注口径
 * - 省略 warehouse_code 时跨三仓汇总，并给出 by_warehouse 明细（D2 用例）
 */
import { AppError } from '@app/shared';
import type {
  QueryInventoryInput,
  QueryInventoryOutput,
  WarehouseCode,
} from '@app/shared';
import type { Database } from '../db.js';

interface StockRow {
  warehouse_code: string;
  on_hand: number;
  reserved: number;
  in_transit: number;
  restock_eta: string | null;
}

interface ProductRow {
  sku: string;
  name: string;
  safety_stock: number;
}

export function queryInventory(db: Database, input: QueryInventoryInput): QueryInventoryOutput {
  const product = db
    .prepare('SELECT sku, name, safety_stock FROM products WHERE sku = ?')
    .get(input.sku) as ProductRow | undefined;

  if (!product) {
    throw new AppError('NOT_FOUND', {
      message: `SKU ${input.sku} 不存在，请确认型号后重试`,
      details: [{ path: '/sku', message: '未找到该 SKU', code: 'unknown_sku' }],
    });
  }

  const rows = db
    .prepare(
      'SELECT warehouse_code, on_hand, reserved, in_transit, restock_eta FROM stock WHERE sku = ? ORDER BY warehouse_code',
    )
    .all(input.sku) as StockRow[];

  const scoped = input.warehouse_code
    ? rows.filter((r) => r.warehouse_code === input.warehouse_code)
    : rows;

  if (scoped.length === 0) {
    throw new AppError('NOT_FOUND', {
      message: `SKU ${input.sku} 未在 ${input.warehouse_code} 备货`,
      details: [{ path: '/warehouse_code', message: '该仓无此 SKU 库存记录', code: 'no_stock_in_warehouse' }],
    });
  }

  const includeReserved = input.include_reserved !== false;
  const availableOf = (r: StockRow) => (includeReserved ? Math.max(0, r.on_hand - r.reserved) : r.on_hand);

  const onHand = scoped.reduce((s, r) => s + r.on_hand, 0);
  const reserved = includeReserved ? scoped.reduce((s, r) => s + r.reserved, 0) : 0;
  const available = scoped.reduce((s, r) => s + availableOf(r), 0);
  const inTransit = scoped.reduce((s, r) => s + r.in_transit, 0);

  const etas = scoped
    .map((r) => r.restock_eta)
    .filter((x): x is string => Boolean(x))
    .sort();

  // 替代型号：与主查询同一仓条件、同一口径（include_reserved=false 时按在库）。
  // 曾经这里只有 WHERE s.sku = ?（全仓汇总）——问「广州仓有什么替代」会报出别的仓的存量，
  // 给出误导数字（seed 里 SKU-B4C5D6 广州仓实为 0，全仓汇总却是 21）。
  const reserveClause = includeReserved ? 'MAX(st.on_hand - st.reserved, 0)' : 'st.on_hand';
  const substitutes = (
    input.warehouse_code
      ? db.prepare(
          `SELECT s.substitute_sku AS sku, p.name AS name, s.compatibility AS compatibility,
                  COALESCE(SUM(${reserveClause}), 0) AS available
             FROM substitutes s
             JOIN products p ON p.sku = s.substitute_sku
             LEFT JOIN stock st ON st.sku = s.substitute_sku AND st.warehouse_code = ?
            WHERE s.sku = ?
            GROUP BY s.substitute_sku, p.name, s.compatibility`,
        ).all(input.warehouse_code, input.sku)
      : db.prepare(
          `SELECT s.substitute_sku AS sku, p.name AS name, s.compatibility AS compatibility,
                  COALESCE(SUM(${reserveClause}), 0) AS available
             FROM substitutes s
             JOIN products p ON p.sku = s.substitute_sku
             LEFT JOIN stock st ON st.sku = s.substitute_sku
            WHERE s.sku = ?
            GROUP BY s.substitute_sku, p.name, s.compatibility`,
        ).all(input.sku)
  ) as Array<{ sku: string; name: string; compatibility: string; available: number }>;

  const output: QueryInventoryOutput = {
    sku: product.sku,
    name: product.name,
    warehouse: (input.warehouse_code ?? 'ALL') as WarehouseCode | 'ALL',
    on_hand: onHand,
    reserved,
    available,
    safety_stock: product.safety_stock,
    below_safety: available < product.safety_stock,
    in_transit: inTransit,
    restock_eta: etas[0] ?? null,
    substitutes: substitutes.map((s) => ({
      sku: s.sku,
      name: s.name,
      available: s.available,
      compatibility: s.compatibility as 'direct' | 'similar' | 'upgrade',
    })),
    quantity_basis: includeReserved ? 'available' : 'on_hand',
  };

  if (!input.warehouse_code) {
    output.by_warehouse = scoped.map((r) => ({
      warehouse: r.warehouse_code as WarehouseCode,
      on_hand: r.on_hand,
      reserved: includeReserved ? r.reserved : 0,
      available: availableOf(r),
    }));
  }

  return output;
}
