-- Migration: Add error_logs table
-- Matches schema.sql definition

CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'client',       -- 'client' or 'server'
  level TEXT NOT NULL DEFAULT 'error',         -- 'error', 'warn', 'fatal'
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,                                     -- page URL (client) or endpoint (server)
  endpoint TEXT,                                -- API endpoint path
  status_code INTEGER,
  user_agent TEXT,
  ip TEXT,
  user_id TEXT,
  metadata TEXT,                                -- JSON extra data
  fingerprint TEXT,                              -- hash for deduplication
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_errors_created ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON error_logs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_source ON error_logs(source, created_at DESC);
