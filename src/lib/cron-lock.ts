// src/lib/cron-lock.ts
// Simple D1-based distributed lock for preventing overlapping cron execution.
// Lock expires after 15 minutes (TTL_MS) to prevent deadlocks from crashed jobs.

const TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Try to acquire a lock for a cron job.
 * Returns true if the lock was acquired, false if already held by another run.
 *
 * Uses INSERT OR IGNORE so only one caller can insert the row. If a stale lock
 * exists (past its expires_at), it is deleted first so the next attempt succeeds.
 */
export async function acquireCronLock(db: D1Database, jobName: string): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_MS);

  // Delete any expired lock for this job
  await db.prepare(
    `DELETE FROM cron_locks WHERE key = ? AND expires_at < ?`
  ).bind(jobName, now.toISOString()).run();

  // Try to insert a new lock — INSERT OR IGNORE means it silently fails
  // if the row already exists (i.e., another process holds the lock).
  const result = await db.prepare(
    `INSERT OR IGNORE INTO cron_locks (key, acquired_at, expires_at) VALUES (?, ?, ?)`
  ).bind(jobName, now.toISOString(), expiresAt.toISOString()).run();

  // If a row was inserted, we acquired the lock
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Release a previously acquired lock.
 */
export async function releaseCronLock(db: D1Database, jobName: string): Promise<void> {
  await db.prepare(
    `DELETE FROM cron_locks WHERE key = ?`
  ).bind(jobName).run();
}
