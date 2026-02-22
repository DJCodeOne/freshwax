// src/pages/api/cron/retry-payouts.ts
// Cron: 0 */6 * * * (every 6 hours)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to retry failed payouts.
// Designed to be called by Cloudflare Cron Trigger or manually via admin panel.
// Supports artists, suppliers, and users (crate sellers).
// Supports both Stripe Connect and PayPal payouts.

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection, updateDocument, addDocument, getDocument, updateDocumentConditional, clearCache, atomicIncrement } from '../../../lib/firebase-rest';
import { sendPayoutCompletedEmail } from '../../../lib/payout-emails';
import { createPayout as createPayPalPayout, getPayPalConfig } from '../../../lib/paypal-payouts';
import { verifyAdminKey } from '../../../lib/admin';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[retry-payouts]');

export const prerender = false;

// Safety limits
const MAX_RETRIES_PER_RUN = 20; // Increased for multiple entity types
const MAX_RETRY_AGE_DAYS = 30; // Don't retry payouts older than 30 days

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();

  const env = locals.runtime.env;

  // Verify cron secret or admin authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;

  // Allow if: bearer token matches cron secret, or x-admin-key matches admin key
  const xAdminKey = request.headers.get('X-Admin-Key');

  const isAuthorized =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (xAdminKey ? verifyAdminKey(xAdminKey, locals) : false);

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  // Initialize Firebase


  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    log.error('Stripe not configured');
    return ApiErrors.serverError('Stripe not configured');
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

    const results = {
      checked: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      stripePayouts: 0,
      paypalPayouts: 0,
      details: [] as Record<string, unknown>[]
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
        results.skipped++;
        continue;
      }

      // Determine entity type and get the entity
      const entityType = pending.entityType || 'artist'; // Default to artist for backwards compatibility
      let entity: Record<string, unknown> | null = null;
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
        log.warn('Entity not found for payout:', pending.id, 'type:', entityType);
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

      results.retried++;

      try {
        // Atomically mark as processing using conditional update to prevent duplicate processing.
        // If another cron run already grabbed this payout, the conditional update will fail.
        try {
          if (pending._updateTime) {
            await updateDocumentConditional('pendingPayouts', pending.id, {
              status: 'processing',
              retryAttemptedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }, pending._updateTime);
          } else {
            await updateDocument('pendingPayouts', pending.id, {
              status: 'processing',
              retryAttemptedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }
        } catch (lockErr: unknown) {
          if (lockErr instanceof Error && lockErr.message.includes('CONFLICT')) {
            // Already being processed by another run
            results.skipped++;
            continue;
          }
          throw lockErr;
        }

        let payoutResult: Record<string, unknown> = {};

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

        // Update entity's total earnings atomically to prevent race conditions
        await atomicIncrement(collection, entity.id, {
          totalEarnings: pending.amount || 0,
          pendingBalance: -(pending.amount || 0),
        });
        await updateDocument(collection, entity.id, {
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
          ).catch(err => log.error('Failed to send email:', err));
        }

        const transactionId = payoutResult.stripeTransferId || payoutResult.paypalPayoutId || 'unknown';
        log.info('Success:', pending.id, 'via', payoutResult.payoutMethod, 'ID:', transactionId);
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

      } catch (transferError: unknown) {
        const transferErrMsg = transferError instanceof Error ? transferError.message : String(transferError);
        log.error('Failed:', pending.id, transferErrMsg);

        // Update with failure reason
        await updateDocument('pendingPayouts', pending.id, {
          status: 'retry_pending',
          failureReason: transferErrMsg,
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
          error: transferErrMsg
        });
      }
    }

    const duration = Date.now() - startTime;

    return new Response(JSON.stringify({
      success: true,
      duration: duration,
      ...results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};

// Also support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => {
  // Forward to POST handler
  return POST(context);
};
