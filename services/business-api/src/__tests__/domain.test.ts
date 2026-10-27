import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@app/shared';
import { openDatabase, type Database } from '../db.js';
import { DDL } from '../ddl.js';
import { seedDatabase } from '../seed.js';
import { queryInventory } from '../domain/inventory.js';
import { queryOrder } from '../domain/orders.js';
import { TicketService } from '../domain/tickets.js';

let db: Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'biz-'));
  db = openDatabase(path.join(dir, 'test.db'));
  db.exec(DDL);
  seedDatabase(db);
});

afterEach(() => {
  db.close();
});

describe('种子数据规模（P1 任务 6 验收口径）', () => {
  it('60 SKU / 3 仓 / 40 订单 / 12 工单', () => {
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(count('SELECT COUNT(*) c FROM products')).toBe(60);
    expect(count('SELECT COUNT(*) c FROM warehouses')).toBe(3);
    expect(count('SELECT COUNT(*) c FROM orders')).toBe(40);
    expect(count('SELECT COUNT(*) c FROM tickets')).toBe(12);
  });
});

describe('T1 可用库存语义', () => {
  it('可用量 = 在库 - 预占，并标记低于安全库存', () => {
    const out = queryInventory(db, { sku: 'SKU-A1B2C3', warehouse_code: 'WH-SZ', include_reserved: true });
    expect(out.on_hand).toBe(25);
    expect(out.reserved).toBe(8);
    expect(out.available).toBe(17);
    expect(out.safety_stock).toBe(40);
    expect(out.below_safety).toBe(true);
    expect(out.quantity_basis).toBe('available');
  });

  it('include_reserved=false 时按在库口径并显式标注', () => {
    const out = queryInventory(db, { sku: 'SKU-A1B2C3', warehouse_code: 'WH-SZ', include_reserved: false });
    expect(out.available).toBe(25);
    expect(out.reserved).toBe(0);
    expect(out.quantity_basis).toBe('on_hand');
  });

  it('不传仓库 → 跨仓汇总且给出分仓明细', () => {
    const out = queryInventory(db, { sku: 'SKU-A1B2C3', include_reserved: true });
    expect(out.warehouse).toBe('ALL');
    expect(out.available).toBe(17 + 9 + 50);
    expect(out.by_warehouse).toHaveLength(3);
  });

  it('替代型号带兼容类型与可用量', () => {
    const out = queryInventory(db, { sku: 'SKU-A1B2C3', warehouse_code: 'WH-SZ', include_reserved: true });
    expect(out.substitutes.map((s) => s.sku)).toContain('SKU-C7D8E9');
    expect(out.substitutes.find((s) => s.sku === 'SKU-C7D8E9')?.compatibility).toBe('upgrade');
  });

  it('替代型号按仓过滤：广州仓查询不报别的仓的存量', () => {
    const all = queryInventory(db, { sku: 'SKU-A1B2C3', include_reserved: true });
    const gz = queryInventory(db, { sku: 'SKU-A1B2C3', warehouse_code: 'WH-GZ', include_reserved: true });
    // seed：B4C5D6 广州仓实为 0，全仓汇总 21——旧实现不按仓过滤会误报 21
    expect(all.substitutes.find((s) => s.sku === 'SKU-B4C5D6')?.available).toBe(21);
    expect(gz.substitutes.find((s) => s.sku === 'SKU-B4C5D6')?.available).toBe(0);
    // C7D8E9：广州仓 5，全仓 33
    expect(gz.substitutes.find((s) => s.sku === 'SKU-C7D8E9')?.available).toBe(5);
    expect(all.substitutes.find((s) => s.sku === 'SKU-C7D8E9')?.available).toBe(33);
  });

  it('替代型号口径与主查询一致：include_reserved=false 时按在库', () => {
    const gz = queryInventory(db, { sku: 'SKU-A1B2C3', warehouse_code: 'WH-GZ', include_reserved: false });
    expect(gz.quantity_basis).toBe('on_hand');
    expect(gz.substitutes.find((s) => s.sku === 'SKU-B4C5D6')?.available).toBe(0);
    expect(gz.substitutes.find((s) => s.sku === 'SKU-C7D8E9')?.available).toBe(5);
  });

  it('未知 SKU → NOT_FOUND', () => {
    expect(() => queryInventory(db, { sku: 'SKU-ZZZZZZ', include_reserved: true })).toThrow(AppError);
  });
});

describe('T2 数据边界', () => {
  it('本人订单可查，且能看出少发', () => {
    const out = queryOrder(db, { order_no: 'SO-20261012-007' }, 'C-10087');
    expect(out.status).toBe('SHIPPED');
    const line = out.lines.find((l) => l.sku === 'SKU-A1B2C3');
    expect(line?.qty).toBe(3);
    expect(line?.shipped_qty).toBe(2);
    expect(out.shipment?.tracking_no).toBe('SF1234567890');
    expect(out.amounts.payable).toBeCloseTo(5110, 2);
  });

  it('他人订单 → FORBIDDEN_DATA_SCOPE（不是 404）', () => {
    try {
      queryOrder(db, { order_no: 'SO-20261012-007' }, 'C-10099');
      throw new Error('应当抛出 403');
    } catch (err) {
      expect((err as AppError).code).toBe('FORBIDDEN_DATA_SCOPE');
    }
  });

  it('不存在的订单 → NOT_FOUND', () => {
    try {
      queryOrder(db, { order_no: 'SO-20260101-999' }, 'C-10087');
      throw new Error('应当抛出 404');
    } catch (err) {
      expect((err as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('手机尾号只在本客户名下检索', () => {
    const out = queryOrder(db, { phone_tail: '8866' }, 'C-10087');
    expect(out.order_no).toMatch(/^SO-\d{8}-\d{3}$/);
    expect(() => queryOrder(db, { phone_tail: '8866' }, 'C-10099')).toThrow(AppError);
  });
});

describe('T3 写工具健壮性', () => {
  const summary = '客户反馈订单 SO-20261012-007 中 SKU-A1B2C3 少发 1 件，要求 48 小时内补发并承担运费。';

  function service() {
    return new TicketService(db, 5, 60_000);
  }

  it('首次创建成功，返回工单号与 SLA', () => {
    const out = service().create(
      {
        category: 'LOGISTICS',
        severity: 'S3',
        summary,
        order_no: 'SO-20261012-007',
        idempotency_key: randomUUID(),
      },
      'C-10087',
    );
    expect(out.ticket_no).toMatch(/^TK-\d{8}-\d{4}$/);
    expect(out.deduplicated).toBe(false);
    expect(out.owner_group).toBe('售后物流组');
  });

  it('同一幂等键重放 → 同一工单号 + deduplicated=true', () => {
    const key = randomUUID();
    const s = service();
    const first = s.create({ category: 'LOGISTICS', severity: 'S3', summary, order_no: 'SO-20261012-007', idempotency_key: key }, 'C-10087');
    const second = s.create({ category: 'LOGISTICS', severity: 'S3', summary, order_no: 'SO-20261012-007', idempotency_key: key }, 'C-10087');
    expect(second.ticket_no).toBe(first.ticket_no);
    expect(second.deduplicated).toBe(true);
  });

  it('同订单同类别已有未关闭工单 → DUPLICATE_TICKET', () => {
    service().create({ category: 'QUALITY', severity: 'S3', summary, order_no: 'SO-20261012-007', idempotency_key: randomUUID() }, 'C-10087');
    try {
      service().create({ category: 'QUALITY', severity: 'S3', summary, order_no: 'SO-20261012-007', idempotency_key: randomUUID() }, 'C-10087');
      throw new Error('应当抛出 409');
    } catch (err) {
      expect((err as AppError).code).toBe('DUPLICATE_TICKET');
    }
  });

  it('同订单同类别但问题不同 → 允许新建（不折叠）', () => {
    const s = service();
    const first = s.create(
      {
        category: 'LOGISTICS',
        severity: 'S3',
        summary: '客户反馈订单少发一件压力传感器，要求补发并说明物流时效。',
        order_no: 'SO-20261012-007',
        idempotency_key: randomUUID(),
      },
      'C-10087',
    );
    const second = s.create(
      {
        category: 'LOGISTICS',
        severity: 'S3',
        summary: '客户反馈外箱严重破损，内件缺少缓冲材料，要求整单换货处理。',
        order_no: 'SO-20261012-007',
        idempotency_key: randomUUID(),
      },
      'C-10087',
    );
    expect(second.ticket_no).not.toBe(first.ticket_no);
    expect(second.deduplicated).toBe(false);
  });

  it('同订单同类别且摘要只差标点 → 仍判重复（409）', () => {
    service().create(
      {
        category: 'LOGISTICS',
        severity: 'S3',
        summary: '客户反馈订单少发一件压力传感器，要求补发并说明物流时效。',
        order_no: 'SO-20261012-007',
        idempotency_key: randomUUID(),
      },
      'C-10087',
    );
    try {
      service().create(
        {
          category: 'LOGISTICS',
          severity: 'S3',
          summary: '客户反馈订单少发一件压力传感器  要求补发并说明物流时效！',
          order_no: 'SO-20261012-007',
          idempotency_key: randomUUID(),
        },
        'C-10087',
      );
      throw new Error('应当抛出 409');
    } catch (err) {
      expect((err as AppError).code).toBe('DUPLICATE_TICKET');
    }
  });

  it('同订单同类别未关闭工单达到 3 张 → 拒绝继续建单', () => {
    const s = service();
    const summaries = [
      '客户反馈少发一件压力传感器，要求补发并说明物流时效。',
      '客户反馈外箱严重破损，内件缺少缓冲材料，要求整单换货处理。',
      '客户反馈物流长时间停滞在广州中转场，要求核实并给出预计送达时间。',
    ];
    for (const summary of summaries) {
      s.create(
        { category: 'LOGISTICS', severity: 'S3', summary, order_no: 'SO-20261012-007', idempotency_key: randomUUID() },
        'C-10087',
      );
    }
    try {
      s.create(
        {
          category: 'LOGISTICS',
          severity: 'S3',
          summary: '客户反馈签收人信息错误，要求联系承运商更正派送地址并重新派送。',
          order_no: 'SO-20261012-007',
          idempotency_key: randomUUID(),
        },
        'C-10087',
      );
      throw new Error('应当抛出 409');
    } catch (err) {
      expect((err as AppError).code).toBe('DUPLICATE_TICKET');
      expect((err as AppError).details?.[0]?.code).toBe('open_ticket_limit');
    }
  });

  it('给他人订单建单 → FORBIDDEN_DATA_SCOPE', () => {
    try {
      service().create({ category: 'OTHER', severity: 'S4', summary, order_no: 'SO-20261012-007', idempotency_key: randomUUID() }, 'C-10099');
      throw new Error('应当抛出 403');
    } catch (err) {
      expect((err as AppError).code).toBe('FORBIDDEN_DATA_SCOPE');
    }
  });

  it('工单详情：本人可读；他人读取 → FORBIDDEN_DATA_SCOPE（不是 404）', () => {
    const s = service();
    const created = s.create(
      { category: 'LOGISTICS', severity: 'S3', summary, order_no: 'SO-20261012-007', idempotency_key: randomUUID() },
      'C-10087',
    );
    const mine = s.get(created.ticket_no, 'C-10087');
    expect(mine.ticket_no).toBe(created.ticket_no);
    expect(mine.customer_id).toBe('C-10087');
    try {
      s.get(created.ticket_no, 'C-10099');
      throw new Error('应当抛出 403');
    } catch (err) {
      expect((err as AppError).code).toBe('FORBIDDEN_DATA_SCOPE');
    }
  });

  it('工单详情：不存在 → NOT_FOUND', () => {
    expect(() => service().get('TK-20260101-9999', 'C-10087')).toThrow(AppError);
    try {
      service().get('TK-20260101-9999', 'C-10087');
    } catch (err) {
      expect((err as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('超过 5 单/分钟 → RATE_LIMITED', () => {
    const s = service();
    for (let i = 0; i < 5; i += 1) {
      s.create(
        { category: 'OTHER', severity: 'S4', summary, idempotency_key: randomUUID() },
        'C-10112',
      );
    }
    try {
      s.create({ category: 'OTHER', severity: 'S4', summary, idempotency_key: randomUUID() }, 'C-10112');
      throw new Error('应当抛出 429');
    } catch (err) {
      expect((err as AppError).code).toBe('RATE_LIMITED');
    }
  });
});
