-- Migration 0005: Add cron_locks table for distributed cron locking
-- Description: Prevents overlapping cron job execution by providing a
--   simple D1-based distributed lock with TTL-based expiration.
--   Used by src/lib/cron-lock.ts acquireCronLock() / releaseCronLock().
-- Applied to: freshwax-db
-- Idempotent: Yes (CREATE TABLE IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS cron_locks (
  key TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
