-- Add pending_orders table (previously created inline by webhook handler)
CREATE TABLE IF NOT EXISTS pending_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id TEXT UNIQUE NOT NULL,
  customer_email TEXT,
  amount_total INTEGER,
  currency TEXT DEFAULT 'gbp',
  items TEXT,
  status TEXT DEFAULT 'pending',
  firebase_order_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
