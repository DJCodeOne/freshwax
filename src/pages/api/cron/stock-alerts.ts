// src/pages/api/cron/stock-alerts.ts
// DISABLED: Low stock admin email alerts — turned off per user request.
// This endpoint is NOT called by the cron scheduler (.github/workflows/retry-payouts.yml)
// or listed in the middleware rate-limit skip list.
// To re-enable: restore the workflow step, add back to RATE_LIMIT_SKIP in middleware.ts,
// and remove the early return below.

import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async () => {
  return new Response(JSON.stringify({
    success: true,
    skipped: true,
    reason: 'Stock alerts disabled'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const GET: APIRoute = async (context) => POST(context);
