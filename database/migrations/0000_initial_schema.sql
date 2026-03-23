-- Migration 0000: Initial schema (retroactive documentation of existing tables)
-- These tables were created directly via wrangler d1 execute before the
-- numbered migration system was introduced. This file is 0000 to avoid
-- conflicting with 0001_add_sales_ledger.sql (the first real migration).

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT,
  customer_email TEXT,
  total_amount REAL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS releases_v2 (
  id TEXT PRIMARY KEY,
  title TEXT,
  artist_id TEXT,
  artist_name TEXT,
  cover_url TEXT,
  price_per_sale REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dj_mixes (
  id TEXT PRIMARY KEY,
  title TEXT,
  dj_id TEXT,
  dj_name TEXT,
  artwork_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  item_id TEXT,
  item_type TEXT,
  seller_id TEXT,
  amount REAL,
  platform_fee REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_reservations (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  variant_key TEXT,
  user_id TEXT,
  session_id TEXT,
  quantity INTEGER DEFAULT 1,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cron_locks (
  job_name TEXT PRIMARY KEY,
  locked_at TEXT,
  locked_by TEXT
);

CREATE TABLE IF NOT EXISTS image_scan_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT,
  format TEXT,
  size INTEGER,
  scanned_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  actor_id TEXT,
  actor_name TEXT,
  target_id TEXT,
  target_type TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dj_support (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mix_id TEXT,
  release_id TEXT,
  dj_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS follower_counts (
  artist_id TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_order ON sales_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_seller ON sales_ledger(seller_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_item ON stock_reservations(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_expires ON stock_reservations(expires_at);
CREATE INDEX IF NOT EXISTS idx_activity_feed_type ON activity_feed(type);
CREATE INDEX IF NOT EXISTS idx_activity_feed_created ON activity_feed(created_at);
CREATE INDEX IF NOT EXISTS idx_dj_support_mix ON dj_support(mix_id);
CREATE INDEX IF NOT EXISTS idx_dj_support_release ON dj_support(release_id);
