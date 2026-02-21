// src/pages/api/cron/cleanup-d1.ts
// Cron: 0 3 * * * (daily at 03:00 UTC)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to clean up old D1 data that grows unbounded.
// Targets:
//   - error_logs: delete rows older than 30 days
//   - pending_orders: delete completed rows older than 90 days
//   - image_scan_results: delete rows older than 30 days

import type { APIRoute } from 'astro';
import { cleanupErrorLogs } from '../../../lib/error-logger';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const logger = createLogger('cleanup-d1');

export const prerender = false;

const ERROR_LOGS_RETENTION_DAYS = 30;
const PENDING_ORDERS_RETENTION_DAYS = 90;

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  logger.info('[Cleanup D1] ========== CRON JOB STARTED ==========');

  const env = locals.runtime.env;

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const isAuthorized =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (adminKey && xAdminKey === adminKey);

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  const db = env?.DB;
  if (!db) {
    logger.error('[Cleanup D1] D1 binding not available');
    return ApiErrors.serverError('D1 not available');
  }

  const results: Record<string, any> = {};

  // 1. Clean up error_logs older than 30 days
  try {
    const deletedErrors = await cleanupErrorLogs(env, ERROR_LOGS_RETENTION_DAYS);
    logger.info(`[Cleanup D1] error_logs: deleted ${deletedErrors} rows older than ${ERROR_LOGS_RETENTION_DAYS} days`);
    results.errorLogs = { deleted: deletedErrors, retentionDays: ERROR_LOGS_RETENTION_DAYS };
  } catch (err) {
    logger.error('[Cleanup D1] error_logs cleanup failed:', err instanceof Error ? err.message : String(err));
    results.errorLogs = { error: 'cleanup failed' };
  }

  // 2. Clean up pending_orders — only completed/expired rows older than 90 days
  //    Rows with status='pending' or 'failed' are kept regardless of age (they need admin attention)
  try {
    const cutoff = new Date(Date.now() - PENDING_ORDERS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = await db.prepare(
      `DELETE FROM pending_orders WHERE status = 'completed' AND created_at < ?`
    ).bind(cutoff).run();
    const deletedOrders = result?.meta?.changes || 0;
    logger.info(`[Cleanup D1] pending_orders: deleted ${deletedOrders} completed rows older than ${PENDING_ORDERS_RETENTION_DAYS} days`);
    results.pendingOrders = { deleted: deletedOrders, retentionDays: PENDING_ORDERS_RETENTION_DAYS };
  } catch (err) {
    logger.error('[Cleanup D1] pending_orders cleanup failed:', err instanceof Error ? err.message : String(err));
    results.pendingOrders = { error: 'cleanup failed' };
  }

  // 3. Clean up image_scan_results older than 30 days (if table exists)
  try {
    const scanResult = await db.prepare(
      `DELETE FROM image_scan_results WHERE created_at < datetime('now', '-30 days')`
    ).run();
    const deletedScans = scanResult?.meta?.changes || 0;
    if (deletedScans > 0) {
      logger.info(`[Cleanup D1] image_scan_results: deleted ${deletedScans} rows`);
    }
    results.imageScanResults = { deleted: deletedScans };
  } catch {
    // Table may not exist — that's fine, skip silently
  }

  const duration = Date.now() - startTime;
  logger.info('[Cleanup D1] ========== COMPLETED ==========');
  logger.info('[Cleanup D1] Duration:', duration, 'ms');

  return new Response(JSON.stringify({
    success: true,
    duration,
    ...results
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
