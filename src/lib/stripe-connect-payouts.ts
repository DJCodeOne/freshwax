// src/lib/stripe-connect-payouts.ts
// Transfers an entity's payable pendingPayouts rows to their Stripe Connect
// account. Extracted from the Connect webhook so the admin "Pay via Stripe"
// action can drive the same engine — per operator policy (Aug 2026) ALL
// payouts are manual unless PAYOUTS_AUTO_TRANSFER=true, so the webhook only
// calls this when that flag is set, while /api/admin/send-stripe-payout
// calls it on demand after the operator has checked the platform balance.

import Stripe from 'stripe';
import { queryCollection, updateDocument, addDocument, getDocument, atomicIncrement } from './firebase-rest';
import { sendPayoutCompletedEmail } from './payout-emails';
import { createLogger } from './api-utils';

const log = createLogger('[connect-payouts]');

const MAX_PENDING_PAYOUTS = 50; // Max pending payouts to process at once

export interface PendingPayoutRunResult {
  processed: number;
  transferredAmount: number;
  failed: number;
}

// Process pending payouts for an entity with an active Connect account.
// Supports artists, suppliers, and users (crate sellers).
export async function processPendingPayouts(entityType: 'artist' | 'supplier' | 'user', entityId: string, stripeConnectId: string, stripeSecretKey: string, env: Record<string, unknown>): Promise<PendingPayoutRunResult> {
  const result: PendingPayoutRunResult = { processed: 0, transferredAmount: 0, failed: 0 };

  // Determine field name for query
  const idField = entityType === 'artist' ? 'artistId' :
                  entityType === 'supplier' ? 'supplierId' :
                  'sellerId';

  // Process 'pending' as well as 'awaiting_connect': the artist payout
  // writers (order-flow and Stripe-webhook processArtistPayments) only ever
  // write status 'pending', so matching solely on 'awaiting_connect' made
  // activation silently transfer nothing — the backlog stayed pending forever.
  // 'retry_pending' is payable too: a run that failed (e.g. insufficient
  // platform balance) marks rows retry_pending, and the operator's next
  // "Pay via Stripe" after topping up must be able to pick them back up.
  // 'processing' is deliberately NOT payable — a crashed run may have made
  // the transfer before marking the row, and re-paying it would double-pay.
  const PAYABLE_STATUSES = ['awaiting_connect', 'pending', 'retry_pending'];
  const pendingPayouts = await queryCollection('pendingPayouts', {
    filters: [
      { field: idField, op: 'EQUAL', value: entityId },
      { field: 'status', op: 'IN', value: PAYABLE_STATUSES }
    ],
    limit: MAX_PENDING_PAYOUTS
  });

  // Also get any with entityId field
  const pendingByEntityId = await queryCollection('pendingPayouts', {
    filters: [
      { field: 'entityId', op: 'EQUAL', value: entityId },
      { field: 'entityType', op: 'EQUAL', value: entityType },
      { field: 'status', op: 'IN', value: PAYABLE_STATUSES }
    ],
    limit: MAX_PENDING_PAYOUTS
  });

  // Merge and dedupe
  const allPending = [...pendingPayouts];
  for (const p of pendingByEntityId) {
    if (!allPending.find(existing => existing.id === p.id)) {
      allPending.push(p);
    }
  }

  if (allPending.length === 0) return result;

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  // Get entity for email and name
  let entity: Record<string, unknown> | null = null;
  let collection: string;

  switch (entityType) {
    case 'supplier':
      collection = 'merch-suppliers';
      entity = await getDocument('merch-suppliers', entityId);
      break;
    case 'user':
      collection = 'users';
      entity = await getDocument('users', entityId);
      break;
    case 'artist':
    default:
      collection = 'artists';
      entity = await getDocument('artists', entityId);
      break;
  }

  // Determine payout collection
  const payoutCollection = entityType === 'supplier' ? 'supplierPayouts' :
                           entityType === 'user' ? 'crateSellerPayouts' :
                           'payouts';

  // Process each pending payout
  for (const pending of allPending) {
    const entityName = pending.artistName || pending.supplierName || pending.sellerName ||
                       entity?.artistName || entity?.name || entity?.displayName || 'Entity';
    const entityEmail = pending.artistEmail || pending.supplierEmail || pending.sellerEmail ||
                        entity?.email || '';

    try {
      // Mark as processing
      await updateDocument('pendingPayouts', pending.id, {
        status: 'processing',
        stripeConnectId,
        updatedAt: new Date().toISOString()
      });

      // Create transfer
      const transfer = await stripe.transfers.create({
        amount: Math.round((pending.amount || 0) * 100), // Convert to pence
        currency: pending.currency || 'gbp',
        destination: stripeConnectId,
        transfer_group: pending.orderId,
        metadata: {
          pendingPayoutId: pending.id,
          orderId: pending.orderId,
          orderNumber: pending.orderNumber,
          entityType,
          entityId,
          entityName,
          platform: 'freshwax'
        }
      });

      // Create payout record
      await addDocument(payoutCollection, {
        ...(entityType === 'artist' ? { artistId: entityId, artistName: entityName, artistEmail: entityEmail } : {}),
        ...(entityType === 'supplier' ? { supplierId: entityId, supplierName: entityName, supplierEmail: entityEmail } : {}),
        ...(entityType === 'user' ? { sellerId: entityId, sellerName: entityName, sellerEmail: entityEmail } : {}),
        entityType,
        stripeConnectId: stripeConnectId,
        stripeTransferId: transfer.id,
        payoutMethod: 'stripe',
        orderId: pending.orderId,
        orderNumber: pending.orderNumber,
        amount: pending.amount,
        currency: pending.currency || 'gbp',
        status: 'completed',
        fromPendingPayout: pending.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });

      // Update entity's total earnings atomically
      await atomicIncrement(collection, entityId, {
        totalEarnings: pending.amount || 0,
        pendingBalance: -(pending.amount || 0),
      });
      await updateDocument(collection, entityId, {
        lastPayoutAt: new Date().toISOString()
      });

      // Mark pending payout as completed
      await updateDocument('pendingPayouts', pending.id, {
        status: 'completed',
        stripeTransferId: transfer.id,
        payoutMethod: 'stripe',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      result.processed += 1;
      result.transferredAmount += Number(pending.amount) || 0;

      // Send payout completed email notification
      if (entityEmail) {
        try {
          await sendPayoutCompletedEmail(
            entityEmail as string,
            entityName as string,
            pending.amount as number,
            (pending.orderNumber || (pending.orderId as string)?.slice(-6).toUpperCase()) as string,
            env as Parameters<typeof sendPayoutCompletedEmail>[4]
          );
        } catch (err: unknown) {
          log.error('Failed to send payout email:', err);
        }
      }

    } catch (transferError: unknown) {
      const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
      log.error('Failed to process pending payout:', pending.id, transferMessage);
      result.failed += 1;

      // Mark as failed for retry
      await updateDocument('pendingPayouts', pending.id, {
        status: 'retry_pending',
        failureReason: transferMessage,
        updatedAt: new Date().toISOString()
      });
    }
  }

  return result;
}
