// src/pages/api/admin/fix-ledger-payout.ts
// Update ledger entry with artistPayout and artistPayoutStatus from pendingPayouts
// Usage: GET /api/admin/fix-ledger-payout?orderNumber=FW-xxx&confirm=yes

import type { APIRoute } from 'astro';
import { initFirebaseEnv, queryCollection } from '../../../lib/firebase-rest';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';

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
  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const confirm = url.searchParams.get('confirm') === 'yes';

  if (!orderNumber) {
    return new Response(JSON.stringify({
      error: 'Missing orderNumber',
      usage: '/api/admin/fix-ledger-payout?orderNumber=FW-xxx&confirm=yes'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const env = (locals as any)?.runtime?.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const serviceAccountKey = getServiceAccountKey(env);

  if (!serviceAccountKey) {
    return new Response(JSON.stringify({ error: 'Service account not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // Find order
    const orders = await queryCollection('orders', {
      filters: [{ field: 'orderNumber', op: 'EQUAL', value: orderNumber }],
      limit: 1
    });

    if (orders.length === 0) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const order = orders[0];
    const orderId = order.id;

    // Get ledger entry
    const ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    if (ledgerEntries.length === 0) {
      return new Response(JSON.stringify({ error: 'Ledger entry not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ledgerEntry = ledgerEntries[0];

    // Get pending payout
    const pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    if (pendingPayouts.length === 0) {
      return new Response(JSON.stringify({ error: 'Pending payout not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
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

  } catch (error) {
    console.error('[fix-ledger-payout] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
