// src/lib/stripe-webhook/disputes.ts
// Dispute handling for Stripe webhook

import Stripe from 'stripe';
import { getDocument, queryCollection, addDocument, updateDocument, atomicIncrement } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-disputes');

// Handle dispute created - reverse transfers to recover funds from artists
export async function handleDisputeCreated(dispute: Record<string, unknown>, stripeSecretKey: string) {
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    const disputeAmount = dispute.amount / 100; // Convert from cents to GBP

    // Process dispute for charge

    // Get the charge to find the payment intent and transfer group
    const charge = await stripe.charges.retrieve(chargeId, {
      expand: ['transfer_group', 'payment_intent']
    });

    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    // Find the order by payment intent
    let order = null;
    if (paymentIntentId) {
      const orders = await queryCollection('orders', {
        filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
        limit: 1
      });
      order = orders.length > 0 ? orders[0] : null;
    }

    // Find related transfers by transfer_group (orderId)
    const transferGroup = charge.transfer_group || order?.id;
    let transfersReversed: Record<string, unknown>[] = [];
    let totalRecovered = 0;

    if (transferGroup) {
      // List all transfers in this transfer group
      const transfers = await stripe.transfers.list({
        transfer_group: transferGroup,
        limit: 100
      });

      // Found transfers to potentially reverse

      // Reverse each transfer to recover funds
      for (const transfer of transfers.data) {
        // Skip if already fully reversed
        if (transfer.reversed) {
          // Transfer already reversed
          continue;
        }

        try {
          // Reverse the transfer
          const reversal = await stripe.transfers.createReversal(transfer.id, {
            description: `Dispute ${dispute.id} - ${dispute.reason}`,
            metadata: {
              disputeId: dispute.id,
              reason: dispute.reason,
              chargeId: chargeId
            }
          });

          const reversedAmount = reversal.amount / 100;
          totalRecovered += reversedAmount;

          transfersReversed.push({
            transferId: transfer.id,
            reversalId: reversal.id,
            amount: reversedAmount,
            artistId: transfer.metadata?.artistId,
            artistName: transfer.metadata?.artistName
          });

          // Transfer reversed

          // Update the payout record
          const payouts = await queryCollection('payouts', {
            filters: [{ field: 'stripeTransferId', op: 'EQUAL', value: transfer.id }],
            limit: 1
          });

          if (payouts.length > 0) {
            await updateDocument('payouts', payouts[0].id, {
              status: 'reversed',
              reversedAt: new Date().toISOString(),
              reversedAmount: reversedAmount,
              reversalReason: `Dispute: ${dispute.reason}`,
              disputeId: dispute.id,
              updatedAt: new Date().toISOString()
            });
          }

          // Update artist's total earnings
          const artistId = transfer.metadata?.artistId;
          if (artistId) {
            const artist = await getDocument('artists', artistId);
            if (artist) {
              await updateDocument('artists', artistId, {
                totalEarnings: Math.max(0, (artist.totalEarnings || 0) - reversedAmount),
                updatedAt: new Date().toISOString()
              });
            }
          }

        } catch (reversalError: unknown) {
          const reversalMessage = reversalError instanceof Error ? reversalError.message : String(reversalError);
          log.error('[Stripe Webhook] Failed to reverse transfer:', transfer.id, reversalMessage);
        }
      }
    }

    // Create dispute record in Firestore
    await addDocument('disputes', {
      stripeDisputeId: dispute.id,
      stripeChargeId: chargeId,
      stripePaymentIntentId: paymentIntentId || null,
      orderId: order?.id || transferGroup || null,
      orderNumber: order?.orderNumber || null,
      amount: disputeAmount,
      currency: dispute.currency || 'gbp',
      reason: dispute.reason,
      status: 'open',
      evidenceDueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
      transfersReversed: transfersReversed,
      amountRecovered: totalRecovered,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    // Dispute recorded and transfers reversed

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Stripe Webhook] Error handling dispute:', message);
    // Still record the dispute even if transfer reversal failed
    await addDocument('disputes', {
      stripeDisputeId: dispute.id,
      stripeChargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id,
      amount: dispute.amount / 100,
      currency: dispute.currency || 'gbp',
      reason: dispute.reason,
      status: 'open',
      error: 'Internal error',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

// Handle dispute closed - update status and track outcome
export async function handleDisputeClosed(dispute: Record<string, unknown>, stripeSecretKey: string) {
  try {
    // Find the dispute record
    const disputes = await queryCollection('disputes', {
      filters: [{ field: 'stripeDisputeId', op: 'EQUAL', value: dispute.id }],
      limit: 1
    });

    if (disputes.length === 0) {
      log.error('[Stripe Webhook] Dispute record not found:', dispute.id);
      return;
    }

    const disputeRecord = disputes[0];
    const outcome = dispute.status === 'won' ? 'won' : 'lost';

    // Calculate net impact
    let netImpact = 0;
    let retransfersCreated: Record<string, unknown>[] = [];

    if (outcome === 'lost') {
      // We lost - platform absorbs the loss minus any recovered amount
      netImpact = disputeRecord.amount - (disputeRecord.amountRecovered || 0);
    } else if (outcome === 'won' && disputeRecord.transfersReversed?.length > 0) {
      // We won - re-transfer to artists since they shouldn't lose money
      // Dispute won - re-transferring to artists

      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

      for (const reversedTransfer of disputeRecord.transfersReversed) {
        try {
          // Get the artist's current Stripe Connect ID
          const artist = await getDocument('artists', reversedTransfer.artistId);

          if (!artist?.stripeConnectId || artist.stripeConnectStatus !== 'active') {
            // Artist no longer has active Connect - storing as pending

            // Store as pending payout
            await addDocument('pendingPayouts', {
              artistId: reversedTransfer.artistId,
              artistName: reversedTransfer.artistName,
              artistEmail: artist?.email || '',
              orderId: disputeRecord.orderId,
              orderNumber: disputeRecord.orderNumber || '',
              amount: reversedTransfer.amount,
              currency: 'gbp',
              status: 'awaiting_connect',
              reason: 'dispute_won_retransfer',
              originalTransferId: reversedTransfer.transferId,
              disputeId: dispute.id,
              notificationSent: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            continue;
          }

          // Create new transfer
          const transfer = await stripe.transfers.create({
            amount: Math.round(reversedTransfer.amount * 100),
            currency: 'gbp',
            destination: artist.stripeConnectId,
            transfer_group: disputeRecord.orderId,
            metadata: {
              orderId: disputeRecord.orderId,
              orderNumber: disputeRecord.orderNumber || '',
              artistId: reversedTransfer.artistId,
              artistName: reversedTransfer.artistName,
              reason: 'dispute_won_retransfer',
              originalTransferId: reversedTransfer.transferId,
              disputeId: dispute.id,
              platform: 'freshwax'
            }
          });

          retransfersCreated.push({
            newTransferId: transfer.id,
            originalTransferId: reversedTransfer.transferId,
            amount: reversedTransfer.amount,
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName
          });

          // Create payout record
          await addDocument('payouts', {
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName,
            artistEmail: artist.email || '',
            stripeConnectId: artist.stripeConnectId,
            stripeTransferId: transfer.id,
            orderId: disputeRecord.orderId,
            orderNumber: disputeRecord.orderNumber || '',
            amount: reversedTransfer.amount,
            currency: 'gbp',
            status: 'completed',
            reason: 'dispute_won_retransfer',
            originalTransferId: reversedTransfer.transferId,
            disputeId: dispute.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Restore artist's earnings atomically
          await atomicIncrement('artists', reversedTransfer.artistId, {
            totalEarnings: reversedTransfer.amount,
          });
          await updateDocument('artists', reversedTransfer.artistId, {
            updatedAt: new Date().toISOString()
          });

          // Re-transferred to artist

        } catch (retransferError: unknown) {
          const retransferMessage = retransferError instanceof Error ? retransferError.message : String(retransferError);
          log.error('[Stripe Webhook] Failed to re-transfer to artist:', reversedTransfer.artistId, retransferMessage);

          // Store as pending for retry
          await addDocument('pendingPayouts', {
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName,
            orderId: disputeRecord.orderId,
            orderNumber: disputeRecord.orderNumber || '',
            amount: reversedTransfer.amount,
            currency: 'gbp',
            status: 'retry_pending',
            reason: 'dispute_won_retransfer',
            originalTransferId: reversedTransfer.transferId,
            disputeId: dispute.id,
            failureReason: retransferMessage,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      }

      netImpact = 0; // We recovered the funds and paid artists
    }

    await updateDocument('disputes', disputeRecord.id, {
      status: outcome === 'won' ? 'won' : 'lost',
      outcome: outcome,
      resolvedAt: new Date().toISOString(),
      netImpact: netImpact,
      retransfersCreated: retransfersCreated.length > 0 ? retransfersCreated : null,
      retransferCount: retransfersCreated.length,
      updatedAt: new Date().toISOString()
    });

    // Dispute closed

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Stripe Webhook] Error handling dispute closure:', message);
  }
}
