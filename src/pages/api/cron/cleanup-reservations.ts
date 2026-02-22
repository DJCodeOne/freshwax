// src/pages/api/cron/cleanup-reservations.ts
// Cron: 0 * * * * (every hour)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to expire stale stock reservations.
// Reservations older than their TTL are released back to available stock.

import type { APIRoute } from 'astro';

import { cleanupExpiredReservations } from '../../../lib/order-utils';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('[cleanup-reservations]');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  log.info('[Cleanup Reservations] ========== CRON JOB STARTED ==========');

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

  try {
    const cleaned = await cleanupExpiredReservations();
    const duration = Date.now() - startTime;
    log.info(`[Cleanup Reservations] Done. Cleaned: ${cleaned}, Duration: ${duration}ms`);
    log.info('[Cleanup Reservations] ========== COMPLETED ==========');

    return successResponse({ cleaned, duration });
  } catch (err: unknown) {
    log.error('[Cleanup Reservations] Error:', err instanceof Error ? err.message : String(err));
    return ApiErrors.serverError('Cleanup failed');
  }
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
