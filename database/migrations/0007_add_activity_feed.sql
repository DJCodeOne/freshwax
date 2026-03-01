-- Migration 0007: Add activity_feed table for platform-wide event tracking
-- Description: Stores timestamped activity events (new releases, mixes, follows,
--   likes, comments, ratings, livestream events, DJ support) for global and
--   personalized activity feeds. Cleaned up by cleanup-d1 cron (90-day retention).
-- Applied to: freshwax-db
-- Idempotent: Yes (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS activity_feed (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_avatar TEXT,
  target_id TEXT,
  target_type TEXT,
  target_name TEXT,
  target_image TEXT,
  target_url TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feed_type ON activity_feed(event_type);
CREATE INDEX IF NOT EXISTS idx_feed_actor ON activity_feed(actor_id);
CREATE INDEX IF NOT EXISTS idx_feed_target ON activity_feed(target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_feed_created ON activity_feed(created_at DESC);
