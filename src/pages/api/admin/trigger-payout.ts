// src/pages/api/admin/trigger-payout.ts
// Admin endpoint to manually trigger artist payouts for an order
// Used for: manual orders, failed auto-payouts, retries

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, addDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { createPayout, getPayPalConfig } from '../../../lib/paypal-payouts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const bodyData = await request.json();

    // Admin auth required
    const authError = requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    // Rate limit
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`admin-payout:${clientId}`, RateLimiters.write);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    const { orderId, artistId } = bodyData;

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

    console.log('[admin] Triggering payout for order:', order.orderNumber);

    // Get PayPal config
    const paypalConfig = getPayPalConfig(env);
    if (!paypalConfig) {
      return new Response(JSON.stringify({ error: 'PayPal not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Calculate artist payments from order items
    const items = order.items || [];
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      paypalEmail: string | null;
      amount: number;
      items: string[];
    }> = {};

    for (const item of items) {
      // Skip merch items
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      // Get release to find artist
      const release = await getDocument('releases', releaseId);
      if (!release) continue;

      const itemArtistId = item.artistId || release.artistId || release.userId;
      if (!itemArtistId) continue;

      // Filter by specific artist if provided
      if (artistId && itemArtistId !== artistId) continue;

      // Get artist for PayPal email
      const artist = await getDocument('artists', itemArtistId);
      const paypalEmail = artist?.paypalEmail || null;

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Calculate artist share (subtract platform fees - Bandcamp style)
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // PayPal fee: 1.4% + £0.20 (applied to total order, but approximate per item)
      const paypalFeePercent = 0.014;
      const paypalFixedFee = 0.20 / items.length; // Split fixed fee across items
      const paypalFee = (itemTotal * paypalFeePercent) + paypalFixedFee;
      const artistShare = itemTotal - freshWaxFee - paypalFee;

      if (!artistPayments[itemArtistId]) {
        artistPayments[itemArtistId] = {
          artistId: itemArtistId,
          artistName: artist?.artistName || release.artistName || 'Unknown Artist',
          paypalEmail,
          amount: 0,
          items: []
        };
      }

      artistPayments[itemArtistId].amount += artistShare;
      artistPayments[itemArtistId].items.push(item.name || 'Item');
    }

    const results: any[] = [];

    for (const payment of Object.values(artistPayments)) {
      if (payment.amount <= 0) continue;

      if (!payment.paypalEmail) {
        results.push({
          artistId: payment.artistId,
          artistName: payment.artistName,
          amount: payment.amount,
          status: 'skipped',
          reason: 'No PayPal email configured'
        });
        continue;
      }

      console.log('[admin] Paying', payment.artistName, '£' + payment.amount.toFixed(2), 'to', payment.paypalEmail);

      try {
        const payoutResult = await createPayout(paypalConfig, {
          email: payment.paypalEmail,
          amount: payment.amount,
          currency: 'GBP',
          note: `Fresh Wax payout for order ${order.orderNumber}`,
          reference: `${orderId}-${payment.artistId}`
        });

        if (payoutResult.success) {
          // Record the payout
          await addDocument('payouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            paypalEmail: payment.paypalEmail,
            paypalBatchId: payoutResult.batchId,
            paypalPayoutItemId: payoutResult.payoutItemId,
            orderId,
            orderNumber: order.orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            payoutMethod: 'paypal',
            triggeredBy: 'admin',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Update artist earnings
          const artist = await getDocument('artists', payment.artistId);
          if (artist) {
            await updateDocument('artists', payment.artistId, {
              totalEarnings: (artist.totalEarnings || 0) + payment.amount,
              lastPayoutAt: new Date().toISOString()
            });
          }

          results.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: payment.amount,
            status: 'success',
            batchId: payoutResult.batchId
          });

          console.log('[admin] ✓ Payout successful:', payoutResult.batchId);
        } else {
          results.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: payment.amount,
            status: 'failed',
            error: payoutResult.error
          });
        }
      } catch (err: any) {
        results.push({
          artistId: payment.artistId,
          artistName: payment.artistName,
          amount: payment.amount,
          status: 'error',
          error: err.message
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      orderId,
      orderNumber: order.orderNumber,
      payouts: results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin] Trigger payout error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to trigger payout'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
