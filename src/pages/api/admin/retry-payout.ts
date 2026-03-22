// src/pages/api/admin/retry-payout.ts
// Admin endpoint to manually retry a failed payout

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { getDocument, updateDocument, addDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors, successResponse } from '../../../lib/api-utils';

const RetryPayoutSchema = z.object({
  payoutId: z.string().min(1),
  adminKey: z.string().optional(),
}).strip();

const log = createLogger('[retry-payout]');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`retry-payout:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = locals.runtime.env;

  // Initialize Firebase


  try {
    const rawBody = await request.json().catch(() => ({}));

    // Require admin auth
    const authError = await requireAdminAuth(request, locals, rawBody);
    if (authError) return authError;

    const parseResult = RetryPayoutSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { payoutId } = parseResult.data;

    // Get the pending payout
    const pendingPayout = await getDocument('pendingPayouts', payoutId);

    if (!pendingPayout) {
      return ApiErrors.notFound('Pending payout not found');
    }

    // Check status is retryable
    if (pendingPayout.status !== 'retry_pending' && pendingPayout.status !== 'awaiting_connect') {
      return ApiErrors.badRequest('Cannot retry payout with status: ${pendingPayout.status}');
    }

    // Get the artist to check their Stripe Connect status
    const artist = await getDocument('artists', pendingPayout.artistId);

    if (!artist) {
      return ApiErrors.notFound('Artist not found');
    }

    if (!artist.stripeConnectId || artist.stripeConnectStatus !== 'active') {
      return ApiErrors.badRequest('Artist has not completed Stripe Connect setup');
    }

    // Get Stripe key
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return ApiErrors.serverError('Stripe not configured');
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

      log.info('Successfully retried payout:', payoutId, 'Transfer:', transfer.id);

      return successResponse({ transferId: transfer.id,
        amount: pendingPayout.amount });

    } catch (transferError: unknown) {
      const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
      log.error('Transfer failed:', transferMessage);

      // Update with new failure reason
      await updateDocument('pendingPayouts', payoutId, {
        status: 'retry_pending',
        failureReason: transferMessage,
        lastRetryFailedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      return ApiErrors.serverError('Transfer failed');
    }

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to retry payout');
  }
};
