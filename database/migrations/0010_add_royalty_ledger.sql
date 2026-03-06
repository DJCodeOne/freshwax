-- Royalty ledger for tracking brand royalties on merch sales
-- Each non-FreshWax brand gets 10% of sale price after processing fees

CREATE TABLE IF NOT EXISTS royalty_ledger (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  brand_account_id TEXT,
  brand_name TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  sale_total REAL NOT NULL,
  royalty_pct REAL NOT NULL DEFAULT 10.0,
  royalty_amount REAL NOT NULL,
  freshwax_amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_royalty_brand ON royalty_ledger(brand_name);
CREATE INDEX IF NOT EXISTS idx_royalty_status ON royalty_ledger(status);
CREATE INDEX IF NOT EXISTS idx_royalty_order ON royalty_ledger(order_id);
