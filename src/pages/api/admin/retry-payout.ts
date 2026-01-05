// src/pages/api/admin/retry-payout.ts
// Admin endpoint to manually retry a failed payout

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`retry-payout:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;

  // Initialize Firebase
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json().catch(() => ({}));

    // Require admin auth
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { payoutId } = body;

    if (!payoutId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Payout ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get the pending payout
    const pendingPayout = await getDocument('pendingPayouts', payoutId);

    if (!pendingPayout) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Pending payout not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Check status is retryable
    if (pendingPayout.status !== 'retry_pending' && pendingPayout.status !== 'awaiting_connect') {
      return new Response(JSON.stringify({
        success: false,
        error: `Cannot retry payout with status: ${pendingPayout.status}`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get the artist to check their Stripe Connect status
    const artist = await getDocument('artists', pendingPayout.artistId);

    if (!artist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    if (!artist.stripeConnectId || artist.stripeConnectStatus !== 'active') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist has not completed Stripe Connect setup'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get Stripe key
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stripe not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

    // Mark as processing
    await updateDocument('pendingPayouts', payoutId, {
      status: 'processing',
      retryAttemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    try {
      // Create transfer
      const transfer = await stripe.transfers.create({
        amount: Math.round((pendingPayout.amount || 0) * 100),
        currency: pendingPayout.currency || 'gbp',
        destination: artist.stripeConnectId,
        transfer_group: pendingPayout.orderId,
        metadata: {
          pendingPayoutId: payoutId,
          orderId: pendingPayout.orderId,
          orderNumber: pendingPayout.orderNumber || '',
          artistId: pendingPayout.artistId,
          artistName: pendingPayout.artistName,
          retryManual: 'true',
          platform: 'freshwax'
        }
      });

      // Create payout record
      await addDocument('payouts', {
        artistId: pendingPayout.artistId,
        artistName: pendingPayout.artistName,
        artistEmail: pendingPayout.artistEmail || artist.email || '',
        stripeConnectId: artist.stripeConnectId,
        stripeTransferId: transfer.id,
        orderId: pendingPayout.orderId,
        orderNumber: pendingPayout.orderNumber || '',
        amount: pendingPayout.amount,
        currency: pendingPayout.currency || 'gbp',
        status: 'completed',
        fromPendingPayout: payoutId,
        manualRetry: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });

      // Update artist's total earnings
      await updateDocument('artists', pendingPayout.artistId, {
        totalEarnings: (artist.totalEarnings || 0) + (pendingPayout.amount || 0),
        lastPayoutAt: new Date().toISOString()
      });

      // Mark pending payout as completed
      await updateDocument('pendingPayouts', payoutId, {
        status: 'completed',
        stripeTransferId: transfer.id,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      console.log('[retry-payout] Successfully retried payout:', payoutId, 'Transfer:', transfer.id);

      return new Response(JSON.stringify({
        success: true,
        transferId: transfer.id,
        amount: pendingPayout.amount
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } catch (transferError: any) {
      console.error('[retry-payout] Transfer failed:', transferError.message);

      // Update with new failure reason
      await updateDocument('pendingPayouts', payoutId, {
        status: 'retry_pending',
        failureReason: transferError.message,
        lastRetryFailedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      return new Response(JSON.stringify({
        success: false,
        error: `Transfer failed: ${transferError.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

  } catch (error) {
    console.error('[retry-payout] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
