// src/pages/api/cron/backup-d1.ts
// Cron: 0 2 * * * (daily at 02:00 UTC)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to export all D1 tables to R2 as JSON backups.
// Stores backups at: backups/d1/{table}/{ISO-timestamp}.json

import type { APIRoute } from 'astro';
import { ApiErrors, createLogger, timingSafeCompare, successResponse } from '../../../lib/api-utils';
import { acquireCronLock, releaseCronLock } from '../../../lib/cron-lock';

const log = createLogger('backup-d1');

export const prerender = false;

const BACKUP_TABLES = [
  'sales_ledger',
  'vinyl_listings',
  'pending_orders',
  'email_logs',
  'error_logs',
  'releases_v2',
  'dj_mixes',
  'merch',
  'comments',
  'ratings',
  'user_ratings',
  'livestream_slots',
  'user_playlists',
  'vinyl_sellers',
  'activity_feed',
  'dj_support',
  'follower_counts',
  'royalty_ledger',
  'image_scan_results',
  'cron_locks',
];

const PAGE_SIZE = 10000;
const RETENTION_DAYS = 30;

/**
 * Paginated query — fetches all rows from a table in PAGE_SIZE chunks
 * to avoid Worker memory limits on large tables.
 */
async function fetchAllRows(db: D1Database, table: string): Promise<Record<string, unknown>[]> {
  // Validate table name against whitelist to prevent SQL injection
  if (!BACKUP_TABLES.includes(table)) {
    throw new Error(`Table "${table}" is not in the BACKUP_TABLES whitelist`);
  }

  const allRows: Record<string, unknown>[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { results: rows } = await db
      .prepare(`SELECT * FROM \`${table}\` LIMIT ${PAGE_SIZE} OFFSET ?`)
      .bind(offset)
      .all();

    const batch = (rows ?? []) as Record<string, unknown>[];
    allRows.push(...batch);

    if (batch.length < PAGE_SIZE) break; // last page
    offset += PAGE_SIZE;
  }

  return allRows;
}

/**
 * Delete R2 backup files older than RETENTION_DAYS for each table prefix.
 * Returns total number of deleted objects.
 */
async function cleanupOldBackups(r2: R2Bucket): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalDeleted = 0;

  for (const table of BACKUP_TABLES) {
    const prefix = `backups/d1/${table}/`;
    let cursor: string | undefined;

    // Paginate through R2 listing (max 1000 per call)
    do {
      const listed = await r2.list({ prefix, cursor });

      const keysToDelete: string[] = [];
      for (const obj of listed.objects) {
        // Filename is an ISO timestamp: e.g. "2026-01-15T02:00:00.000Z.json"
        const filename = obj.key.slice(prefix.length); // "2026-01-15T02:00:00.000Z.json"
        const isoStr = filename.replace(/\.json$/, '');
        const fileDate = new Date(isoStr).getTime();
        if (!isNaN(fileDate) && fileDate < cutoff) {
          keysToDelete.push(obj.key);
        }
      }

      if (keysToDelete.length > 0) {
        await r2.delete(keysToDelete);
        totalDeleted += keysToDelete.length;
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  return totalDeleted;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  log.info('[Backup D1] ========== CRON JOB STARTED ==========');

  const env = locals.runtime.env;

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isAuthorized =
    (cronSecret && token && timingSafeCompare(token, cronSecret)) ||
    (adminKey && xAdminKey && timingSafeCompare(xAdminKey, adminKey));

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  const db: D1Database | undefined = env?.DB;
  const r2: R2Bucket | undefined = env?.R2;

  if (!db) {
    log.error('[Backup D1] D1 binding not available');
    return ApiErrors.serverError('D1 not available');
  }

  if (!r2) {
    log.error('[Backup D1] R2 binding not available');
    return ApiErrors.serverError('R2 not available');
  }

  const locked = await acquireCronLock(db, 'backup-d1');
  if (!locked) {
    return ApiErrors.conflict('Job already running');
  }

  try {
    const timestamp = new Date().toISOString();
    const results: Record<string, { rows: number } | { error: string }> = {};

    // Backup all tables in parallel
    const backupResults = await Promise.allSettled(
      BACKUP_TABLES.map(async (table) => {
        try {
          const data = await fetchAllRows(db, table);
          const key = `backups/d1/${table}/${timestamp}.json`;
          await r2.put(key, JSON.stringify(data, null, 2), {
            httpMetadata: { contentType: 'application/json' },
          });
          log.info(`[Backup D1] ${table}: backed up ${data.length} rows to ${key}`);
          results[table] = { rows: data.length };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`[Backup D1] ${table} backup failed:`, message);
          results[table] = { error: 'backup failed' };
        }
      })
    );

    // Retention cleanup — delete backups older than 30 days
    let deletedCount = 0;
    try {
      deletedCount = await cleanupOldBackups(r2);
      if (deletedCount > 0) {
        log.info(`[Backup D1] Retention cleanup: deleted ${deletedCount} old backup(s)`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[Backup D1] Retention cleanup failed:', message);
    }

    const duration = Date.now() - startTime;
    log.info('[Backup D1] ========== COMPLETED ==========');
    log.info(`[Backup D1] Duration: ${duration}ms`);

    return successResponse({ duration, timestamp, tables: results, retentionCleanup: { deletedCount } });
  } finally {
    await releaseCronLock(db, 'backup-d1');
  }
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
