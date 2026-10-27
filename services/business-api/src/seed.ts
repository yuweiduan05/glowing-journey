/**
 * 确定性种子数据（对应 P1 任务 6：60 SKU / 3 仓 / 40 订单 / 12 工单）
 *
 * 用固定种子的伪随机数生成，保证任何机器上跑出来的演示数据完全一致，
 * 评测与截图可复现（对应 ADR-006「业务数据全 Mock」）。
 */
import type { Database } from './db.js';

/** mulberry32：32 位确定性 PRNG */
function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WAREHOUSES = [
  { code: 'WH-SZ', name: '深圳仓', city: '深圳', cutoff: '18:00' },
  { code: 'WH-GZ', name: '广州仓', city: '广州', cutoff: '17:30' },
  { code: 'WH-SH', name: '上海仓', city: '上海', cutoff: '18:00' },
];

const CUSTOMERS = [
  { id: 'C-10087', name: '深圳市恒达自动化设备有限公司', phone: '8866' },
  { id: 'C-10099', name: '广州启明办公设备有限公司', phone: '2031' },
  { id: 'C-10112', name: '东莞信越五金制品厂', phone: '7712' },
  { id: 'C-10138', name: '苏州云创仓储服务有限公司', phone: '4408' },
  { id: 'C-10154', name: '上海协作智能科技有限公司', phone: '9902' },
  { id: 'C-10177', name: '佛山顺德佳合贸易有限公司', phone: '3355' },
  { id: 'C-10190', name: '杭州普立办公用品有限公司', phone: '6120' },
  { id: 'C-10206', name: '宁波海曙机电经营部', phone: '1893' },
];

/** 三条产品线（与知识库 doc 的 product_line 取值保持一致） */
const PRODUCT_LINES = [
  {
    key: 'industrial-sensor',
    label: '工业传感器',
    names: [
      '压力传感器 PX-200',
      '压力传感器 PX-210',
      '压力传感器 PX-300',
      '光电传感器 PS-12A',
      '光电传感器 PS-15B',
      '接近开关 PR-8M',
      '接近开关 PR-12M',
      '温度变送器 TT-40',
      '温度变送器 TT-60',
      '流量计 FM-25',
    ],
    price: [88000, 168000] as const,
  },
  {
    key: 'office-printer',
    label: '办公打印设备',
    names: [
      '激光打印机 LP-4500',
      '激光打印机 LP-5200',
      '喷墨一体机 IJ-2200',
      '标签打印机 TB-300',
      '高速扫描仪 SC-700',
      '原装硒鼓 CR-4500',
      '兼容硒鼓 CR-4500C',
      '打印纸 A4 80g（5 包/箱）',
      '热转印碳带 TR-110',
      '打印机维护套件 MK-01',
    ],
    price: [4500, 480000] as const,
  },
  {
    key: 'warehouse-consumable',
    label: '仓储耗材',
    names: [
      'PE 缠绕膜 50cm',
      'PE 缠绕膜 30cm',
      '热敏标签纸 100×150',
      '热敏标签纸 60×40',
      '打包带 PP 12mm',
      '打包扣 塑料',
      '防静电周转箱 600×400',
      '瓦楞纸箱 5 层',
      '气泡袋 大号',
      '封箱胶带 透明 60mm',
    ],
    price: [1200, 26000] as const,
  },
];

/** 演示锚点 SKU：保证 D1/D2 用例的数值稳定 */
const HERO_SKUS = [
  { sku: 'SKU-A1B2C3', name: '压力传感器 PX-200', line: 'industrial-sensor', safety: 40 },
  { sku: 'SKU-B4C5D6', name: '压力传感器 PX-210', line: 'industrial-sensor', safety: 40 },
  { sku: 'SKU-C7D8E9', name: '压力传感器 PX-300', line: 'industrial-sensor', safety: 25 },
  { sku: 'SKU-D1E2F3', name: '激光打印机 LP-4500', line: 'office-printer', safety: 15 },
  { sku: 'SKU-E4F5A6', name: 'PE 缠绕膜 50cm', line: 'warehouse-consumable', safety: 120 },
  { sku: 'SKU-F7A8B9', name: '热敏标签纸 100×150', line: 'warehouse-consumable', safety: 200 },
];

const TICKET_OWNER: Record<string, string> = {
  LOGISTICS: '售后物流组',
  QUALITY: '质量工程组',
  RETURN: '退货处理组',
  INVOICE: '财务结算组',
  OTHER: '一线客服组',
};

const SLA_HOURS: Record<string, number> = { S2: 4, S3: 24, S4: 72 };

function pick<T>(rng: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rng() * arr.length)];
  if (item === undefined) throw new Error('pick: empty array');
  return item;
}

function hex(rng: () => number, len: number): string {
  const chars = 'ABCDEF0123456789';
  let out = '';
  for (let i = 0; i < len; i += 1) out += chars[Math.floor(rng() * chars.length)];
  return out;
}

function uuid(rng: () => number): string {
  const h = (n: number) => hex(rng, n).toLowerCase();
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

function isoDate(rng: () => number, base: Date, dayOffset: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(9 + Math.floor(rng() * 8), Math.floor(rng() * 60), 0, 0);
  return d.toISOString();
}

export function seedDatabase(db: Database): void {
  const rng = createRng(20261022);
  const baseDate = new Date('2026-09-01T00:00:00Z');

  db.exec('BEGIN');
  try {
    for (const w of WAREHOUSES) {
      db.prepare('INSERT INTO warehouses (code, name, city, cutoff_time) VALUES (?, ?, ?, ?)').run(
        w.code,
        w.name,
        w.city,
        w.cutoff,
      );
    }

    for (const c of CUSTOMERS) {
      db.prepare('INSERT INTO customers (id, name, phone_tail) VALUES (?, ?, ?)').run(
        c.id,
        c.name,
        c.phone,
      );
    }

    // ---- 产品：6 个锚点 SKU + 54 个生成 SKU = 60 ----
    const products: Array<{
      sku: string;
      name: string;
      line: string;
      safety: number;
      priceCents: number;
    }> = [];

    for (const hero of HERO_SKUS) {
      const lineDef = PRODUCT_LINES.find((l) => l.key === hero.line);
      const priceCents = Math.round((lineDef ? pick(rng, lineDef.price) : 10000) / 100) * 100;
      products.push({ ...hero, priceCents });
    }

    while (products.length < 60) {
      const lineDef = pick(rng, PRODUCT_LINES);
      const name = pick(rng, lineDef.names);
      const sku = `SKU-${hex(rng, 6)}`;
      if (products.some((p) => p.sku === sku)) continue;
      products.push({
        sku,
        name,
        line: lineDef.key,
        safety: 10 + Math.floor(rng() * 190),
        priceCents: Math.round(pick(rng, lineDef.price) / 100) * 100,
      });
    }

    for (const p of products) {
      db.prepare(
        'INSERT INTO products (sku, name, product_line, safety_stock, price_cents) VALUES (?, ?, ?, ?, ?)',
      ).run(p.sku, p.name, p.line, p.safety, p.priceCents);
    }

    // ---- 库存：每个 SKU × 3 仓 ----
    const heroStock: Record<string, Array<[string, number, number, number, string | null]>> = {
      'SKU-A1B2C3': [
        ['WH-SZ', 25, 8, 100, '2026-10-28'],
        ['WH-GZ', 12, 3, 0, null],
        ['WH-SH', 60, 10, 50, '2026-11-02'],
      ],
      'SKU-B4C5D6': [
        ['WH-SZ', 6, 1, 0, null],
        ['WH-GZ', 0, 0, 0, null],
        ['WH-SH', 18, 2, 0, null],
      ],
      'SKU-C7D8E9': [
        ['WH-SZ', 0, 0, 0, null],
        ['WH-GZ', 5, 0, 0, null],
        ['WH-SH', 32, 4, 20, '2026-10-30'],
      ],
      'SKU-D1E2F3': [
        ['WH-SZ', 9, 2, 0, null],
        ['WH-GZ', 4, 0, 0, null],
        ['WH-SH', 2, 1, 30, '2026-11-05'],
      ],
      'SKU-E4F5A6': [
        ['WH-SZ', 380, 60, 0, null],
        ['WH-GZ', 210, 30, 0, null],
        ['WH-SH', 90, 10, 0, null],
      ],
      'SKU-F7A8B9': [
        ['WH-SZ', 540, 120, 0, null],
        ['WH-GZ', 160, 20, 0, null],
        ['WH-SH', 75, 5, 0, null],
      ],
    };

    for (const p of products) {
      const preset = heroStock[p.sku];
      for (const w of WAREHOUSES) {
        const fixed = preset?.find(([code]) => code === w.code);
        if (fixed) {
          const [, onHand, reserved, inTransit, eta] = fixed;
          db.prepare(
            'INSERT INTO stock (sku, warehouse_code, on_hand, reserved, in_transit, restock_eta) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(p.sku, w.code, onHand, reserved, inTransit, eta);
        } else {
          const onHand = Math.floor(rng() * 130);
          const reserved = Math.floor(rng() * Math.min(20, onHand + 1));
          const inTransit = rng() > 0.75 ? Math.floor(rng() * 100) : 0;
          const eta = inTransit > 0 ? isoDate(rng, new Date('2026-10-25T00:00:00Z'), Math.floor(rng() * 12)).slice(0, 10) : null;
          db.prepare(
            'INSERT INTO stock (sku, warehouse_code, on_hand, reserved, in_transit, restock_eta) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(p.sku, w.code, onHand, reserved, inTransit, eta);
        }
      }
    }

    // ---- 替代型号 ----
    const substitutes: Array<[string, string, string]> = [
      ['SKU-A1B2C3', 'SKU-B4C5D6', 'similar'],
      ['SKU-A1B2C3', 'SKU-C7D8E9', 'upgrade'],
      ['SKU-B4C5D6', 'SKU-A1B2C3', 'similar'],
      ['SKU-C7D8E9', 'SKU-A1B2C3', 'similar'],
      ['SKU-D1E2F3', 'SKU-C7D8E9', 'direct'],
    ];
    for (const [a, b, c] of substitutes) {
      db.prepare('INSERT INTO substitutes (sku, substitute_sku, compatibility) VALUES (?, ?, ?)').run(a, b, c);
    }

    // ---- 订单：1 张锚点订单 + 39 张生成订单 ----
    const statusPool = ['CREATED', 'PAID', 'PICKING', 'SHIPPED', 'DELIVERED', 'CLOSED', 'REFUNDING'] as const;
    const orderCount = 40;

    const insertOrder = db.prepare(
      `INSERT INTO orders (order_no, customer_id, status, goods_cents, discount_cents, freight_cents,
        payable_cents, carrier, tracking_no, eta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLine = db.prepare(
      'INSERT INTO order_lines (order_no, sku, qty, shipped_qty, unit_price_cents) VALUES (?, ?, ?, ?, ?)',
    );

    // 锚点订单：已发货但少发一件（D3 / D4 用例）
    {
      const lines = [
        { sku: 'SKU-A1B2C3', qty: 3, shipped: 2 },
        { sku: 'SKU-F7A8B9', qty: 10, shipped: 10 },
      ];
      let goods = 0;
      for (const l of lines) {
        const p = products.find((x) => x.sku === l.sku)!;
        goods += p.priceCents * l.qty;
      }
      const discount = 10000;
      const freight = 5000;
      insertOrder.run(
        'SO-20261012-007',
        'C-10087',
        'SHIPPED',
        goods,
        discount,
        freight,
        goods - discount + freight,
        '顺丰速运',
        'SF1234567890',
        '2026-10-20',
        '2026-10-12T02:15:00.000Z',
      );
      for (const l of lines) {
        const p = products.find((x) => x.sku === l.sku)!;
        insertLine.run('SO-20261012-007', l.sku, l.qty, l.shipped, p.priceCents);
      }
    }

    for (let i = 0; i < orderCount - 1; i += 1) {
      const day = Math.floor(rng() * 30);
      const seq = String(i + 1).padStart(3, '0');
      const orderNo = `SO-2026${String(9 + Math.floor(day / 30)).padStart(2, '0')}${String(
        (day % 28) + 1,
      ).padStart(2, '0')}-${seq}`;
      const customer = pick(rng, CUSTOMERS);
      const status = pick(rng, statusPool);
      const lineCount = 1 + Math.floor(rng() * 3);
      const chosen = new Set<string>();
      let goods = 0;
      const lineRows: Array<{ sku: string; qty: number; shipped: number; price: number }> = [];
      for (let k = 0; k < lineCount; k += 1) {
        const p = pick(rng, products);
        if (chosen.has(p.sku)) continue;
        chosen.add(p.sku);
        const qty = 1 + Math.floor(rng() * 12);
        const shipped =
          status === 'SHIPPED' || status === 'DELIVERED' || status === 'CLOSED'
            ? qty
            : status === 'PICKING'
              ? Math.max(0, qty - 1)
              : 0;
        goods += p.priceCents * qty;
        lineRows.push({ sku: p.sku, qty, shipped, price: p.priceCents });
      }
      if (lineRows.length === 0) continue;
      const discount = rng() > 0.6 ? Math.round(goods * 0.03) : 0;
      const freight = 5000;
      const hasShipment = ['SHIPPED', 'DELIVERED', 'CLOSED'].includes(status);
      insertOrder.run(
        orderNo,
        customer.id,
        status,
        goods,
        discount,
        freight,
        goods - discount + freight,
        hasShipment ? '德邦物流' : null,
        hasShipment ? `DB${Math.floor(rng() * 1e10)}` : null,
        hasShipment ? isoDate(rng, baseDate, 20 + Math.floor(rng() * 15)).slice(0, 10) : null,
        isoDate(rng, baseDate, day),
      );
      for (const l of lineRows) insertLine.run(orderNo, l.sku, l.qty, l.shipped, l.price);
    }

    // ---- 工单：12 张，全部避开锚点订单的 LOGISTICS 类别（保证 D4 首次创建成功）----
    const categories = ['LOGISTICS', 'QUALITY', 'RETURN', 'INVOICE', 'OTHER'] as const;
    const severities = ['S2', 'S3', 'S4'] as const;
    const ticketStatuses = ['OPEN', 'PROCESSING', 'CLOSED'] as const;
    const orderRows = db.prepare('SELECT order_no FROM orders WHERE order_no <> ? LIMIT 12').all(
      'SO-20261012-007',
    ) as Array<{ order_no: string }>;

    for (let i = 0; i < 12; i += 1) {
      const orderNo = orderRows[i % orderRows.length]!.order_no;
      const category = pick(rng, categories);
      const severity = pick(rng, severities);
      const createdAt = isoDate(rng, baseDate, 25 + i);
      const slaDue = new Date(new Date(createdAt).getTime() + SLA_HOURS[severity]! * 3600_000);
      db.prepare(
        `INSERT INTO tickets (ticket_no, customer_id, category, severity, summary, order_no, sku, status,
          owner_group, sla_due_at, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `TK-202610${String(10 + (i % 20)).padStart(2, '0')}-${String(i + 1).padStart(4, '0')}`,
        'C-10087',
        category,
        severity,
        `历史工单 ${i + 1}：客户反馈${category === 'LOGISTICS' ? '物流延误' : '产品异常'}，已完成初步沟通，等待进一步处理结果确认。`,
        orderNo,
        null,
        pick(rng, ticketStatuses),
        TICKET_OWNER[category]!,
        slaDue.toISOString(),
        uuid(rng),
        createdAt,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function isSeeded(db: Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number } | undefined;
  return (row?.c ?? 0) > 0;
}
