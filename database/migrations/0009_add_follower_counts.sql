-- Migration 0009: Add follower_counts table for artist follower tracking
-- Description: Maintains denormalized follower counts per artist, incremented/
--   decremented on follow/unfollow actions. Populated via backfill endpoint,
--   then kept in sync by follow-artist.ts.
-- Applied to: freshwax-db
-- Idempotent: Yes (CREATE TABLE IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS follower_counts (
  artist_id TEXT PRIMARY KEY,
  follower_count INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now'))
);
