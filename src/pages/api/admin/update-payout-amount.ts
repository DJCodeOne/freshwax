// src/pages/api/admin/update-payout-amount.ts
// Update pending payout and ledger with actual PayPal fee
// Usage: POST with { orderNumber, actualPaypalFee, artistPayout, adminKey }

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { queryCollection } from '../../../lib/firebase-rest';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/update-payout-amount');

const updatePayoutAmountSchema = z.object({
  orderNumber: z.string().min(1),
  actualPaypalFee: z.number().nonnegative().optional(),
  artistPayout: z.number().nonnegative(),
  adminKey: z.string().optional(),
});

export const prerender = false;

function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-payout-amount:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
    const body = await request.json();

    // Admin auth
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = updatePayoutAmountSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { orderNumber, actualPaypalFee, artistPayout } = parsed.data;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const serviceAccountKey = getServiceAccountKey(env);

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    const saQuery = getSaQuery(locals);

    // Find order
    const orders = await saQuery('orders', {
      filters: [{ field: 'orderNumber', op: 'EQUAL', value: orderNumber }],
      limit: 1
    });

    if (orders.length === 0) {
      return ApiErrors.notFound('Order not found');
    }

    const order = orders[0];
    const orderId = order.id;
    const updates: string[] = [];

    // Update pending payout
    const pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 10
    });

    for (const payout of pendingPayouts) {
      await saUpdateDocument(serviceAccountKey, projectId, 'pendingPayouts', payout.id, {
        amount: artistPayout,
        actualPaypalFee: actualPaypalFee,
        updatedAt: new Date().toISOString(),
        notes: `Updated with actual PayPal fee: £${actualPaypalFee}`
      });
      updates.push(`pendingPayouts/${payout.id}: amount → £${artistPayout}`);
    }

    // Update ledger entry
    const ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    for (const ledger of ledgerEntries) {
      await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', ledger.id, {
        artistPayout: artistPayout,
        actualPaypalFee: actualPaypalFee,
        paypalFee: actualPaypalFee,
        updatedAt: new Date().toISOString()
      });
      updates.push(`salesLedger/${ledger.id}: artistPayout → £${artistPayout}, paypalFee → £${actualPaypalFee}`);
    }

    // Update order with actual PayPal fee (as top-level field since nested updates are tricky)
    if (actualPaypalFee !== undefined) {
      await saUpdateDocument(serviceAccountKey, projectId, 'orders', orderId, {
        actualPaypalFee: actualPaypalFee,
        paypalFee: actualPaypalFee,
        updatedAt: new Date().toISOString()
      });
      updates.push(`orders/${orderId}: paypalFee → £${actualPaypalFee}`);
    }

    return new Response(JSON.stringify({
      success: true,
      orderNumber,
      orderId,
      artistPayout,
      actualPaypalFee,
      updates
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
