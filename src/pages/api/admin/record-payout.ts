// src/pages/api/admin/record-payout.ts
// Admin endpoint to record a manual payout (when artist has already been paid outside the system)

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { saSetDocument, saQueryCollection, saDeleteDocument, saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

// Build service account key from env vars
function getServiceAccountKey(env: any): string {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey?.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const bodyData = await request.json();

    // Admin auth required
    const authError = requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const serviceAccountKey = getServiceAccountKey(env);

    const { orderId, notes } = bodyData;

    if (!orderId) {
      return new Response(JSON.stringify({ error: 'orderId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[admin] Recording manual payout for order:', order.orderNumber || orderId);

    // Calculate artist payments from order items
    const items = order.items || [];
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      amount: number;
      items: string[];
    }> = {};

    for (const item of items) {
      // Skip merch items
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      const artistId = item.artistId || item.artist || 'unknown';
      const artistName = item.artist || item.artistName || 'Unknown Artist';
      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Calculate artist share (subtract platform fees)
      const freshWaxFee = itemTotal * 0.01;
      const processorFeePercent = 0.014;
      const processorFixedFee = 0.20 / items.length;
      const processorFee = (itemTotal * processorFeePercent) + processorFixedFee;
      const artistShare = itemTotal - freshWaxFee - processorFee;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName,
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || 'Item');
    }

    const results: any[] = [];

    for (const payment of Object.values(artistPayments)) {
      // Skip payments with zero or negative amounts (fees exceed item price)
      if (payment.amount <= 0) continue;

      // Record the payout as completed (manual) using service account auth
      const payoutId = `manual_${orderId}_${Date.now()}`;
      await saSetDocument(
        serviceAccountKey,
        projectId,
        'payouts',
        payoutId,
        {
          artistId: payment.artistId,
          artistName: payment.artistName,
          orderId,
          orderNumber: order.orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'completed',
          payoutMethod: 'manual',
          triggeredBy: 'admin',
          notes: notes || 'Manual payout recorded by admin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        }
      );

      results.push({
        artistId: payment.artistId,
        artistName: payment.artistName,
        amount: payment.amount,
        status: 'recorded'
      });

      console.log('[admin] ✓ Recorded manual payout for', payment.artistName, '£' + payment.amount.toFixed(2));
    }

    // If no artist payouts were created (e.g., all items are low-value/merch),
    // create a "cleared" record to mark the order as handled
    if (results.length === 0) {
      const clearedPayoutId = `cleared_${orderId}_${Date.now()}`;
      await saSetDocument(
        serviceAccountKey,
        projectId,
        'payouts',
        clearedPayoutId,
        {
          artistId: 'none',
          artistName: 'Order Cleared',
          orderId,
          orderNumber: order.orderNumber,
          amount: 0,
          currency: 'gbp',
          status: 'completed',
          payoutMethod: 'cleared',
          triggeredBy: 'admin',
          notes: notes || 'Order cleared by admin - no artist payout required',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        }
      );
      results.push({
        artistId: 'none',
        artistName: 'Order Cleared',
        amount: 0,
        status: 'cleared'
      });
      console.log('[admin] ✓ Created cleared record for order', order.orderNumber);
    }

    // Also remove/update any pending payout records for this order
    // This prevents the order from reappearing in the queue
    try {
      const pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
        filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
        limit: 50
      });

      for (const pending of pendingPayouts) {
        // Update the pending payout to mark it as completed (or delete it)
        await saUpdateDocument(serviceAccountKey, projectId, 'pendingPayouts', pending.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          completedBy: 'admin_manual',
          notes: notes || 'Marked as paid by admin'
        });
        console.log('[admin] ✓ Updated pending payout', pending.id, 'to completed');
      }
    } catch (err) {
      console.error('[admin] Error updating pending payouts:', err);
      // Don't fail the request - the payout record was still created
    }

    return new Response(JSON.stringify({
      success: true,
      orderId,
      orderNumber: order.orderNumber,
      payouts: results,
      message: `Recorded ${results.length} payout(s)`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin] Record payout error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to record payout'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
