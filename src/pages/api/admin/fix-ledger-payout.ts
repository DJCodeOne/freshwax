// src/pages/api/admin/fix-ledger-payout.ts
// Update ledger entry with artistPayout and artistPayoutStatus from pendingPayouts
// Usage: GET /api/admin/fix-ledger-payout/?orderNumber=FW-xxx&confirm=yes

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { getSaQuery } from '../../../lib/admin-query';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/fix-ledger-payout');

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

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`fix-ledger-payout:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const confirm = url.searchParams.get('confirm') === 'yes';

  if (!orderNumber) {
    return ApiErrors.badRequest('Missing orderNumber');
  }

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const serviceAccountKey = getServiceAccountKey(env);

  if (!serviceAccountKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  const saQuery = getSaQuery(locals);

  try {
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

    // Get ledger entry
    const ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    if (ledgerEntries.length === 0) {
      return ApiErrors.notFound('Ledger entry not found');
    }

    const ledgerEntry = ledgerEntries[0];

    // Get pending payout
    const pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    if (pendingPayouts.length === 0) {
      return ApiErrors.notFound('Pending payout not found');
    }

    const payout = pendingPayouts[0];

    const updates = {
      artistPayout: payout.amount,
      artistPayoutStatus: payout.status || 'pending',
      artistId: payout.artistId,
      artistName: payout.artistName,
      artistEmail: payout.artistEmail
    };

    if (!confirm) {
      return new Response(JSON.stringify({
        message: 'Would update ledger entry',
        ledgerId: ledgerEntry.id,
        currentValues: {
          artistPayout: ledgerEntry.artistPayout,
          artistPayoutStatus: ledgerEntry.artistPayoutStatus
        },
        newValues: updates,
        usage: 'Add &confirm=yes to apply'
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Apply updates
    await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', ledgerEntry.id, updates);

    return new Response(JSON.stringify({
      success: true,
      message: 'Ledger entry updated',
      ledgerId: ledgerEntry.id,
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
