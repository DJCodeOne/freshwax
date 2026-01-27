// src/pages/api/admin/update-payout-amount.ts
// Update pending payout and ledger with actual PayPal fee
// Usage: POST with { orderNumber, actualPaypalFee, artistPayout, adminKey }

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
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

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const body = await request.json();

    // Admin auth
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { orderNumber, actualPaypalFee, artistPayout } = body;

    if (!orderNumber || artistPayout === undefined) {
      return new Response(JSON.stringify({
        error: 'Missing required fields',
        usage: 'POST { orderNumber, actualPaypalFee, artistPayout, adminKey }'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

  } catch (error) {
    console.error('[update-payout-amount] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
