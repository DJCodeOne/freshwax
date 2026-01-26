// src/pages/api/admin/fix-order-payout.ts
// Create missing pending payout for a specific order
// Usage: GET /api/admin/fix-order-payout?orderId=xxx&confirm=yes

import type { APIRoute } from 'astro';
import { initFirebaseEnv, getDocument } from '../../../lib/firebase-rest';
import { saSetDocument, saUpdateDocument, saQueryCollection } from '../../../lib/firebase-service-account';

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
  const orderId = url.searchParams.get('orderId');
  const confirm = url.searchParams.get('confirm');

  if (!orderId) {
    return new Response(JSON.stringify({
      error: 'Missing orderId',
      usage: '/api/admin/fix-order-payout?orderId=xxx&confirm=yes'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const env = (locals as any)?.runtime?.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const serviceAccountKey = getServiceAccountKey(env);
  if (!serviceAccountKey) {
    return new Response(JSON.stringify({ error: 'Service account not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Get order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if payout already exists for this order
    const existingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    if (existingPayouts.length > 0) {
      return new Response(JSON.stringify({
        message: 'Payout already exists for this order',
        payout: existingPayouts[0]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get release info for each digital item
    const digitalItems = (order.items || []).filter((item: any) =>
      item.type === 'digital' || item.type === 'release' || item.type === 'track'
    );

    if (digitalItems.length === 0) {
      return new Response(JSON.stringify({ error: 'No digital items in order' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Calculate payouts by artist
    const artistPayouts: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      amount: number;
      items: string[];
    }> = {};

    for (const item of digitalItems) {
      const releaseId = item.releaseId || item.productId || item.id;
      if (!releaseId) continue;

      const release = await getDocument('releases', releaseId);
      if (!release) continue;

      const artistId = release.submitterId || release.uploadedBy || release.userId;
      if (!artistId) continue;

      const itemTotal = (item.price || 0) * (item.quantity || 1);
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // Estimate processing fee (PayPal ~2.9% + £0.30)
      const processingFee = (itemTotal * 0.029) + 0.30;
      const artistShare = itemTotal - freshWaxFee - processingFee;

      if (!artistPayouts[artistId]) {
        artistPayouts[artistId] = {
          artistId,
          artistName: release.artistName || release.artist || 'Unknown Artist',
          artistEmail: release.email || release.artistEmail || release.submitterEmail || '',
          amount: 0,
          items: []
        };
      }

      artistPayouts[artistId].amount += artistShare;
      artistPayouts[artistId].items.push(item.title || item.name || 'Item');
    }

    if (Object.keys(artistPayouts).length === 0) {
      return new Response(JSON.stringify({ error: 'Could not determine artist for any items' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (confirm !== 'yes') {
      return new Response(JSON.stringify({
        message: 'Would create the following payouts',
        payouts: Object.values(artistPayouts),
        usage: 'Add &confirm=yes to create'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create pending payouts
    const created: any[] = [];
    const now = new Date().toISOString();

    for (const [artistId, payout] of Object.entries(artistPayouts)) {
      const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const payoutDoc = {
        artistId: payout.artistId,
        artistName: payout.artistName,
        artistEmail: payout.artistEmail,
        orderId,
        orderNumber: order.orderNumber,
        amount: Math.round(payout.amount * 100) / 100,
        itemAmount: Math.round(payout.amount * 100) / 100,
        currency: 'gbp',
        status: 'pending',
        payoutMethod: null,
        customerPaymentMethod: order.paymentMethod || 'paypal',
        items: payout.items,
        notes: 'Created via fix-order-payout',
        createdAt: now,
        updatedAt: now
      };

      await saSetDocument(serviceAccountKey, projectId, 'pendingPayouts', payoutId, payoutDoc);
      created.push({ payoutId, ...payoutDoc });

      // Update artist's pending balance
      try {
        const artist = await getDocument('artists', artistId);
        if (artist) {
          await saUpdateDocument(serviceAccountKey, projectId, 'artists', artistId, {
            pendingBalance: (artist.pendingBalance || 0) + payout.amount,
            updatedAt: now
          });
        }
      } catch (e) {
        console.log('[fix-order-payout] Could not update artist balance');
      }
    }

    // Also update ledger entry with artist info
    try {
      const ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
        filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
        limit: 1
      });

      if (ledgerEntries.length > 0) {
        const firstArtist = Object.values(artistPayouts)[0];
        await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', ledgerEntries[0].id, {
          artistName: firstArtist.artistName,
          submitterEmail: firstArtist.artistEmail,
          artistPayout: firstArtist.amount,
          artistPayoutStatus: 'pending'
        });
      }
    } catch (e) {
      console.log('[fix-order-payout] Could not update ledger entry');
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Created ${created.length} pending payout(s)`,
      payouts: created
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[fix-order-payout] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
