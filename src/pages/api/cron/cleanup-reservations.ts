// src/pages/api/cron/cleanup-reservations.ts
// Cron: 0 * * * * (every hour)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to expire stale stock reservations.
// Reservations older than their TTL are released back to available stock.

import type { APIRoute } from 'astro';

import { cleanupExpiredReservations } from '../../../lib/order-utils';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  console.log('[Cleanup Reservations] ========== CRON JOB STARTED ==========');

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
    console.log(`[Cleanup Reservations] Done. Cleaned: ${cleaned}, Duration: ${duration}ms`);
    console.log('[Cleanup Reservations] ========== COMPLETED ==========');

    return new Response(JSON.stringify({ success: true, cleaned, duration }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: unknown) {
    console.error('[Cleanup Reservations] Error:', err instanceof Error ? err.message : String(err));
    return ApiErrors.serverError('Cleanup failed');
  }
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
