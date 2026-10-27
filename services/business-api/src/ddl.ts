/**
 * 建表语句（对应 2.4「进销存/订单/工单数据与业务规则」）
 * 金额一律以「分」存储为 INTEGER，读取时再转元，规避浮点误差（T2 健壮性考点）。
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS warehouses (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  cutoff_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  sku           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  product_line  TEXT NOT NULL,
  safety_stock  INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  unit          TEXT NOT NULL DEFAULT '件'
);

CREATE TABLE IF NOT EXISTS stock (
  sku            TEXT NOT NULL REFERENCES products(sku),
  warehouse_code TEXT NOT NULL REFERENCES warehouses(code),
  on_hand        INTEGER NOT NULL,
  reserved       INTEGER NOT NULL DEFAULT 0,
  in_transit     INTEGER NOT NULL DEFAULT 0,
  restock_eta    TEXT,
  PRIMARY KEY (sku, warehouse_code)
);

CREATE TABLE IF NOT EXISTS substitutes (
  sku           TEXT NOT NULL REFERENCES products(sku),
  substitute_sku TEXT NOT NULL REFERENCES products(sku),
  compatibility TEXT NOT NULL CHECK (compatibility IN ('direct','similar','upgrade')),
  PRIMARY KEY (sku, substitute_sku)
);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone_tail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_no    TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status      TEXT NOT NULL CHECK (status IN ('CREATED','PAID','PICKING','SHIPPED','DELIVERED','CLOSED','REFUNDING')),
  goods_cents   INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  freight_cents  INTEGER NOT NULL DEFAULT 0,
  payable_cents  INTEGER NOT NULL,
  carrier     TEXT,
  tracking_no TEXT,
  eta         TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no   TEXT NOT NULL REFERENCES orders(order_no),
  sku        TEXT NOT NULL REFERENCES products(sku),
  qty        INTEGER NOT NULL,
  shipped_qty INTEGER NOT NULL DEFAULT 0,
  unit_price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_no       TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  category        TEXT NOT NULL CHECK (category IN ('LOGISTICS','QUALITY','RETURN','INVOICE','OTHER')),
  severity        TEXT NOT NULL CHECK (severity IN ('S2','S3','S4')),
  summary         TEXT NOT NULL,
  order_no        TEXT,
  sku             TEXT,
  status          TEXT NOT NULL CHECK (status IN ('OPEN','PROCESSING','CLOSED')),
  owner_group     TEXT NOT NULL,
  sla_due_at      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_sku ON stock(sku);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON customers(phone_tail);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_no, category, status);
`;
