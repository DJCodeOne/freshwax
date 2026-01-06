// src/pages/api/cron/retry-payouts.ts
// Scheduled job to retry failed payouts
// Designed to be called by Cloudflare Cron Trigger or manually
// Supports artists, suppliers, and users (crate sellers)
// Supports both Stripe Connect and PayPal payouts

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection, updateDocument, addDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { sendPayoutCompletedEmail } from '../../../lib/payout-emails';
import { createPayout as createPayPalPayout, getPayPalConfig } from '../../../lib/paypal-payouts';

export const prerender = false;

// Safety limits
const MAX_RETRIES_PER_RUN = 20; // Increased for multiple entity types
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

  // Get PayPal config
  const paypalConfig = getPayPalConfig(env);

  try {
    // Calculate cutoff date (don't retry very old payouts)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_RETRY_AGE_DAYS);

    // Query pending payouts that need retry (all entity types)
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
      stripePayouts: 0,
      paypalPayouts: 0,
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

      // Determine entity type and get the entity
      const entityType = pending.entityType || 'artist'; // Default to artist for backwards compatibility
      let entity: any = null;
      let collection: string;
      let entityName: string;
      let entityEmail: string;

      switch (entityType) {
        case 'supplier':
          collection = 'merch-suppliers';
          entity = await getDocument('merch-suppliers', pending.supplierId || pending.entityId);
          entityName = entity?.name || pending.supplierName || 'Supplier';
          entityEmail = entity?.email || pending.supplierEmail || '';
          break;

        case 'user':
        case 'crate_seller':
          collection = 'users';
          entity = await getDocument('users', pending.sellerId || pending.entityId);
          entityName = entity?.displayName || entity?.name || pending.sellerName || 'Seller';
          entityEmail = entity?.email || pending.sellerEmail || '';
          break;

        case 'artist':
        default:
          collection = 'artists';
          entity = await getDocument('artists', pending.artistId || pending.entityId);
          entityName = entity?.artistName || entity?.name || pending.artistName || 'Artist';
          entityEmail = entity?.email || pending.artistEmail || '';
          break;
      }

      if (!entity) {
        console.log('[Retry Payouts] Entity not found for payout:', pending.id, 'type:', entityType);
        results.skipped++;
        continue;
      }

      // Check if entity has a valid payout method
      const hasStripe = entity.stripeConnectId && entity.stripeConnectStatus === 'active';
      const hasPayPal = entity.paypalEmail && paypalConfig;
      const preferredMethod = entity.payoutMethod || (hasStripe ? 'stripe' : 'paypal');

      // Determine which method to use
      let usePayPal = false;
      let useStripe = false;

      if (preferredMethod === 'paypal' && hasPayPal) {
        usePayPal = true;
      } else if (hasStripe) {
        useStripe = true;
      } else if (hasPayPal) {
        usePayPal = true;
      }

      if (!useStripe && !usePayPal) {
        // No payout method available yet
        if (pending.status === 'awaiting_connect') {
          results.skipped++;
          continue;
        }

        // Update status to awaiting connect
        await updateDocument('pendingPayouts', pending.id, {
          status: 'awaiting_connect',
          updatedAt: new Date().toISOString()
        });
        results.skipped++;
        continue;
      }

      // Ready to process
      console.log('[Retry Payouts] Retrying payout:', pending.id, 'for', entityType, ':', entityName, 'via', usePayPal ? 'PayPal' : 'Stripe');
      results.retried++;

      try {
        // Mark as processing
        await updateDocument('pendingPayouts', pending.id, {
          status: 'processing',
          retryAttemptedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        let payoutResult: any = {};

        if (usePayPal) {
          // PayPal payout
          const paypalResult = await createPayPalPayout(
            {
              email: entity.paypalEmail,
              amount: pending.amount,
              currency: (pending.currency || 'gbp').toUpperCase(),
              note: `Fresh Wax payout for order ${pending.orderNumber || pending.orderId?.slice(-6).toUpperCase()}`
            },
            paypalConfig!
          );

          if (!paypalResult.success) {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

          payoutResult = {
            paypalBatchId: paypalResult.batchId,
            paypalPayoutId: paypalResult.payoutItemId,
            payoutMethod: 'paypal'
          };
          results.paypalPayouts++;

        } else {
          // Stripe transfer
          const transfer = await stripe.transfers.create({
            amount: Math.round((pending.amount || 0) * 100),
            currency: pending.currency || 'gbp',
            destination: entity.stripeConnectId,
            transfer_group: pending.orderId,
            metadata: {
              pendingPayoutId: pending.id,
              orderId: pending.orderId,
              orderNumber: pending.orderNumber || '',
              entityType,
              entityId: pending.artistId || pending.supplierId || pending.sellerId || pending.entityId,
              entityName,
              cronRetry: 'true',
              platform: 'freshwax'
            }
          });

          payoutResult = {
            stripeTransferId: transfer.id,
            payoutMethod: 'stripe'
          };
          results.stripePayouts++;
        }

        // Determine which collection to use for payout records
        const payoutCollection = entityType === 'supplier' ? 'supplierPayouts' :
                                 entityType === 'user' || entityType === 'crate_seller' ? 'crateSellerPayouts' :
                                 'payouts';

        // Create payout record
        await addDocument(payoutCollection, {
          ...(entityType === 'artist' ? { artistId: pending.artistId || pending.entityId, artistName: entityName, artistEmail: entityEmail } : {}),
          ...(entityType === 'supplier' ? { supplierId: pending.supplierId || pending.entityId, supplierName: entityName, supplierEmail: entityEmail } : {}),
          ...(entityType === 'user' || entityType === 'crate_seller' ? { sellerId: pending.sellerId || pending.entityId, sellerName: entityName, sellerEmail: entityEmail } : {}),
          entityType,
          stripeConnectId: entity.stripeConnectId || null,
          paypalEmail: usePayPal ? entity.paypalEmail : null,
          ...payoutResult,
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

        // Update entity's total earnings
        await updateDocument(collection, entity.id, {
          totalEarnings: (entity.totalEarnings || 0) + (pending.amount || 0),
          pendingBalance: Math.max(0, (entity.pendingBalance || 0) - (pending.amount || 0)),
          lastPayoutAt: new Date().toISOString()
        });

        // Mark pending payout as completed
        await updateDocument('pendingPayouts', pending.id, {
          status: 'completed',
          ...payoutResult,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Send email notification
        if (entityEmail) {
          sendPayoutCompletedEmail(
            entityEmail,
            entityName,
            pending.amount,
            pending.orderNumber || pending.orderId?.slice(-6).toUpperCase(),
            env
          ).catch(err => console.error('[Retry Payouts] Failed to send email:', err));
        }

        const transactionId = payoutResult.stripeTransferId || payoutResult.paypalPayoutId || 'unknown';
        console.log('[Retry Payouts] ✓ Success:', pending.id, 'via', payoutResult.payoutMethod, 'ID:', transactionId);
        results.succeeded++;
        results.details.push({
          payoutId: pending.id,
          entityType,
          entityName,
          amount: pending.amount,
          status: 'success',
          method: payoutResult.payoutMethod,
          transactionId
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
          entityType,
          entityName,
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
