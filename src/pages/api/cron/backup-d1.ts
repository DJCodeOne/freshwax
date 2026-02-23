// src/pages/api/cron/backup-d1.ts
// Cron: 0 2 * * * (daily at 02:00 UTC)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to export all D1 tables to R2 as JSON backups.
// Stores backups at: backups/d1/{table}/{ISO-timestamp}.json

import type { APIRoute } from 'astro';
import { ApiErrors, createLogger, timingSafeCompare, successResponse } from '../../../lib/api-utils';

const log = createLogger('backup-d1');

export const prerender = false;

const BACKUP_TABLES = [
  'sales_ledger',
  'vinyl_listings',
  'pending_orders',
  'email_logs',
  'error_logs',
];

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

  const timestamp = new Date().toISOString();
  const results: Record<string, { rows: number } | { error: string }> = {};

  for (const table of BACKUP_TABLES) {
    try {
      const { results: rows } = await db.prepare(`SELECT * FROM ${table}`).all();
      const data = rows ?? [];
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
  }

  const duration = Date.now() - startTime;
  log.info('[Backup D1] ========== COMPLETED ==========');
  log.info(`[Backup D1] Duration: ${duration}ms`);

  return successResponse({ duration, timestamp, tables: results });
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
