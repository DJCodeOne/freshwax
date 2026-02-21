// src/pages/api/admin/pending-orders.ts
// Admin endpoint to query D1 pending_orders with status='pending' or 'failed'
// These are orders where Stripe/PayPal payment succeeded but Firebase order creation failed
// PayPal rows use stripe_session_id='paypal:{orderId}' prefix to distinguish from Stripe

import type { APIRoute } from 'astro';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/pending-orders');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`pending-orders:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('D1 database not available');
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

  try {
    const { results } = await db.prepare(
      `SELECT id, stripe_session_id, customer_email, amount_total, currency, items, status, firebase_order_id, created_at, updated_at
       FROM pending_orders
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(status, limit).all();

    // Parse items JSON for each row
    const orders = (results || []).map((row: any) => {
      let parsedItems = null;
      try {
        if (row.items) parsedItems = JSON.parse(row.items);
      } catch { /* leave null */ }

      // Derive payment method from the stripe_session_id prefix
      const paymentMethod = row.stripe_session_id?.startsWith('paypal:') ? 'paypal' : 'stripe';
      const paymentRef = paymentMethod === 'paypal'
        ? row.stripe_session_id.replace('paypal:', '')
        : row.stripe_session_id;

      return {
        ...row,
        payment_method: paymentMethod,
        payment_ref: paymentRef,
        amount_display: row.amount_total != null ? (row.amount_total / 100).toFixed(2) : null,
        items_parsed: parsedItems
      };
    });

    return new Response(JSON.stringify({
      status,
      count: orders.length,
      orders
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: unknown) {
    log.error('Error querying pending_orders:', err);
    return ApiErrors.serverError('Failed to query pending orders');
  }
};
