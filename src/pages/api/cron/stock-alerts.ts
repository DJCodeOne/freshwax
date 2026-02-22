// src/pages/api/cron/stock-alerts.ts
// Cron: DISABLED (no cron trigger configured)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// DISABLED: Low stock admin email alerts — turned off per user request.
// This endpoint is NOT called by the cron scheduler.
// To re-enable: add a cron trigger in the Cloudflare dashboard,
// add back to RATE_LIMIT_SKIP in middleware.ts,
// and remove the early return below.

import type { APIRoute } from 'astro';
import { successResponse } from '../../../lib/api-utils';

export const prerender = false;

export const POST: APIRoute = async () => {
  return successResponse({ skipped: true,
    reason: 'Stock alerts disabled' });
};

export const GET: APIRoute = async (context) => POST(context);
