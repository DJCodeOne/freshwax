-- Migration: Add sales_ledger table for D1
-- D1 is primary read source, Firebase is backup

CREATE TABLE IF NOT EXISTS sales_ledger (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  customer_id TEXT,
  customer_email TEXT NOT NULL,
  artist_id TEXT,
  artist_name TEXT,
  submitter_id TEXT,
  submitter_email TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  shipping REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  gross_total REAL NOT NULL DEFAULT 0,
  stripe_fee REAL DEFAULT 0,
  paypal_fee REAL DEFAULT 0,
  freshwax_fee REAL DEFAULT 0,
  total_fees REAL DEFAULT 0,
  net_revenue REAL NOT NULL DEFAULT 0,
  artist_payout REAL DEFAULT 0,
  artist_payout_status TEXT DEFAULT 'pending',
  payment_method TEXT NOT NULL,
  payment_id TEXT,
  currency TEXT DEFAULT 'GBP',
  item_count INTEGER DEFAULT 0,
  has_physical INTEGER DEFAULT 0,
  has_digital INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  corrected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_order ON sales_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order_number ON sales_ledger(order_number);
CREATE INDEX IF NOT EXISTS idx_ledger_timestamp ON sales_ledger(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_year_month ON sales_ledger(year, month);
CREATE INDEX IF NOT EXISTS idx_ledger_artist ON sales_ledger(artist_id);
CREATE INDEX IF NOT EXISTS idx_ledger_submitter ON sales_ledger(submitter_id);
CREATE INDEX IF NOT EXISTS idx_ledger_payout_status ON sales_ledger(artist_payout_status);
CREATE INDEX IF NOT EXISTS idx_ledger_payment_method ON sales_ledger(payment_method);
