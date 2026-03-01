-- Migration 0008: Add dj_support table for tracking DJ-to-release connections
-- Description: Links DJs to the releases they play in their mixes, either via
--   automatic tracklist scanning or manual "I support this" button. Used to
--   display "Supported by DJ X, DJ Y" badges on release pages and DJ profiles.
-- Applied to: freshwax-db
-- Idempotent: Yes (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS dj_support (
  id TEXT PRIMARY KEY,
  mix_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  dj_user_id TEXT,
  dj_name TEXT NOT NULL,
  release_title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_support_release ON dj_support(release_id);
CREATE INDEX IF NOT EXISTS idx_support_mix ON dj_support(mix_id);
CREATE INDEX IF NOT EXISTS idx_support_dj ON dj_support(dj_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_unique ON dj_support(mix_id, release_id);
