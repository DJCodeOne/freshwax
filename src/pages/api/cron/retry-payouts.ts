// src/pages/api/cron/retry-payouts.ts
// Scheduled job to retry failed payouts
// Designed to be called by Cloudflare Cron Trigger or manually

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection, updateDocument, addDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { sendPayoutCompletedEmail } from '../../../lib/payout-emails';

export const prerender = false;

// Safety limits
const MAX_RETRIES_PER_RUN = 10;
const MAX_RETRY_AGE_DAYS = 30; // Don't retry payouts older than 30 days

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  console.log('[Retry Payouts] ========== CRON JOB STARTED ==========');
  console.log('[Retry Payouts] Timestamp:', new Date().toISOString());

  const env = (locals as any)?.runtime?.env;

  // Verify cron secret or admin authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;

  // Allow if: bearer token matches cron secret, or x-admin-key matches admin key
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const isAuthorized =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (adminKey && xAdminKey === adminKey);

  if (!isAuthorized) {
    console.log('[Retry Payouts] Unauthorized - missing or invalid credentials');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Initialize Firebase
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('[Retry Payouts] Stripe not configured');
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Calculate cutoff date (don't retry very old payouts)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_RETRY_AGE_DAYS);

    // Query pending payouts that need retry
    const pendingPayouts = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'status', op: 'IN', value: ['retry_pending', 'awaiting_connect'] }
      ],
      orderBy: [{ field: 'createdAt', direction: 'ASCENDING' }],
      limit: MAX_RETRIES_PER_RUN * 2 // Fetch more to filter
    });

    console.log('[Retry Payouts] Found', pendingPayouts.length, 'pending payouts to check');

    const results = {
      checked: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      details: [] as any[]
    };

    for (const pending of pendingPayouts) {
      results.checked++;

      // Skip if we've hit our per-run limit
      if (results.retried >= MAX_RETRIES_PER_RUN) {
        results.skipped++;
        continue;
      }

      // Skip if too old
      const createdAt = new Date(pending.createdAt);
      if (createdAt < cutoffDate) {
        console.log('[Retry Payouts] Skipping old payout:', pending.id, '- created:', createdAt.toISOString());
        results.skipped++;
        continue;
      }

      // Get artist to check their Connect status
      const artist = await getDocument('artists', pending.artistId);

      if (!artist) {
        console.log('[Retry Payouts] Artist not found for payout:', pending.id);
        results.skipped++;
        continue;
      }

      // Check if artist has completed Connect setup
      if (!artist.stripeConnectId || artist.stripeConnectStatus !== 'active') {
        // Still awaiting connect - skip this one
        if (pending.status === 'awaiting_connect') {
          results.skipped++;
          continue;
        }

        // Was retry_pending but artist still not connected - update status
        await updateDocument('pendingPayouts', pending.id, {
          status: 'awaiting_connect',
          updatedAt: new Date().toISOString()
        });
        results.skipped++;
        continue;
      }

      // Artist is connected - try to process the payout
      console.log('[Retry Payouts] Retrying payout:', pending.id, 'for artist:', pending.artistName);
      results.retried++;

      try {
        // Mark as processing
        await updateDocument('pendingPayouts', pending.id, {
          status: 'processing',
          retryAttemptedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Create transfer
        const transfer = await stripe.transfers.create({
          amount: Math.round((pending.amount || 0) * 100),
          currency: pending.currency || 'gbp',
          destination: artist.stripeConnectId,
          transfer_group: pending.orderId,
          metadata: {
            pendingPayoutId: pending.id,
            orderId: pending.orderId,
            orderNumber: pending.orderNumber || '',
            artistId: pending.artistId,
            artistName: pending.artistName,
            cronRetry: 'true',
            platform: 'freshwax'
          }
        });

        // Create payout record
        await addDocument('payouts', {
          artistId: pending.artistId,
          artistName: pending.artistName,
          artistEmail: pending.artistEmail || artist.email || '',
          stripeConnectId: artist.stripeConnectId,
          stripeTransferId: transfer.id,
          orderId: pending.orderId,
          orderNumber: pending.orderNumber || '',
          amount: pending.amount,
          currency: pending.currency || 'gbp',
          status: 'completed',
          fromPendingPayout: pending.id,
          cronRetry: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });

        // Update artist's total earnings
        await updateDocument('artists', pending.artistId, {
          totalEarnings: (artist.totalEarnings || 0) + (pending.amount || 0),
          pendingBalance: Math.max(0, (artist.pendingBalance || 0) - (pending.amount || 0)),
          lastPayoutAt: new Date().toISOString()
        });

        // Mark pending payout as completed
        await updateDocument('pendingPayouts', pending.id, {
          status: 'completed',
          stripeTransferId: transfer.id,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Send email notification
        const artistEmail = pending.artistEmail || artist.email;
        if (artistEmail) {
          sendPayoutCompletedEmail(
            artistEmail,
            pending.artistName,
            pending.amount,
            pending.orderNumber || pending.orderId?.slice(-6).toUpperCase(),
            env
          ).catch(err => console.error('[Retry Payouts] Failed to send email:', err));
        }

        console.log('[Retry Payouts] ✓ Success:', pending.id, 'Transfer:', transfer.id);
        results.succeeded++;
        results.details.push({
          payoutId: pending.id,
          artistName: pending.artistName,
          amount: pending.amount,
          status: 'success',
          transferId: transfer.id
        });

      } catch (transferError: any) {
        console.error('[Retry Payouts] ✕ Failed:', pending.id, transferError.message);

        // Update with failure reason
        await updateDocument('pendingPayouts', pending.id, {
          status: 'retry_pending',
          failureReason: transferError.message,
          lastRetryFailedAt: new Date().toISOString(),
          retryCount: (pending.retryCount || 0) + 1,
          updatedAt: new Date().toISOString()
        });

        results.failed++;
        results.details.push({
          payoutId: pending.id,
          artistName: pending.artistName,
          amount: pending.amount,
          status: 'failed',
          error: transferError.message
        });
      }
    }

    const duration = Date.now() - startTime;
    console.log('[Retry Payouts] ========== CRON JOB COMPLETED ==========');
    console.log('[Retry Payouts] Duration:', duration, 'ms');
    console.log('[Retry Payouts] Results:', JSON.stringify(results, null, 2));

    return new Response(JSON.stringify({
      success: true,
      duration: duration,
      ...results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Retry Payouts] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Also support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => {
  // Forward to POST handler
  return POST(context);
};
