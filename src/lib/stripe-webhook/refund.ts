// src/lib/stripe-webhook/refund.ts
// Refund handling for Stripe webhook

import Stripe from 'stripe';
import { getDocument, getDocumentsBatch, queryCollection, addDocument, updateDocument } from '../firebase-rest';
import { createLogger } from '../api-utils';
import { sendRefundNotificationEmail } from './emails';

const log = createLogger('stripe-webhook-refund');

// Handle refund - reverse artist transfers proportionally
export async function handleRefund(charge: Record<string, unknown>, stripeSecretKey: string, env: CloudflareEnv) {
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    if (!paymentIntentId) {
      // No payment intent on charge
      return;
    }

    // Find the order by payment intent
    const orders = await queryCollection('orders', {
      filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
      limit: 1
    });

    if (orders.length === 0) {
      log.error('[Stripe Webhook] No order found for payment intent:', paymentIntentId);
      return;
    }

    const order = orders[0];
    const orderId = order.id;

    // Calculate refund percentage
    const totalAmount = charge.amount / 100; // Total charge in GBP
    const refundedAmount = charge.amount_refunded / 100; // Amount refunded in GBP
    const refundPercentage = refundedAmount / totalAmount;
    const isFullRefund = refundPercentage >= 0.99; // Allow for rounding

    // Process refund for order

    // Check if we've already processed refunds for this charge
    const existingRefunds = await queryCollection('refunds', {
      filters: [{ field: 'stripeChargeId', op: 'EQUAL', value: charge.id }],
      limit: 1
    });

    // Calculate how much we've already refunded
    let previouslyRefunded = 0;
    if (existingRefunds.length > 0) {
      previouslyRefunded = existingRefunds.reduce((sum: number, r: Record<string, unknown>) => sum + ((r.amountRefunded as number) || 0), 0);
    }

    // Calculate the new refund amount (incremental)
    const newRefundAmount = refundedAmount - previouslyRefunded;

    if (newRefundAmount <= 0) {
      // No new refund amount to process
      return;
    }

    const newRefundPercentage = newRefundAmount / totalAmount;

    // Refund amount calculated: newRefundAmount GBP

    // Find all completed payouts for this order
    const payouts = await queryCollection('payouts', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: 'status', op: 'EQUAL', value: 'completed' }
      ],
      limit: 50
    });

    if (payouts.length === 0) {
      // No completed payouts found - check pending

      // Check for pending payouts and cancel them
      const pendingPayouts = await queryCollection('pendingPayouts', {
        filters: [
          { field: 'orderId', op: 'EQUAL', value: orderId },
          { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
        ],
        limit: 50
      });

      for (const pending of pendingPayouts) {
        await updateDocument('pendingPayouts', pending.id, {
          status: 'cancelled',
          cancelledReason: 'order_refunded',
          refundPercentage: refundPercentage,
          updatedAt: new Date().toISOString()
        });
        // Cancelled pending payout
      }

      // Record the refund even without transfers to reverse
      await addDocument('refunds', {
        stripeChargeId: charge.id,
        stripePaymentIntentId: paymentIntentId,
        orderId: orderId,
        orderNumber: order.orderNumber || '',
        totalAmount: totalAmount,
        amountRefunded: refundedAmount,
        refundPercentage: refundPercentage,
        isFullRefund: isFullRefund,
        transfersReversed: [],
        pendingPayoutsCancelled: pendingPayouts.length,
        createdAt: new Date().toISOString()
      });

      return;
    }

    // Processing payouts for transfer reversal

    // Reverse transfers proportionally
    let transfersReversed: Record<string, unknown>[] = [];
    let totalReversed = 0;

    // Batch fetch artists to avoid N+1 queries in reversal and notification loops
    const payoutArtistIds = [...new Set(payouts.map((p) => p.artistId).filter(Boolean))] as string[];
    const artistMap = payoutArtistIds.length > 0 ? await getDocumentsBatch('artists', payoutArtistIds) : new Map<string, Record<string, unknown>>();

    for (const payout of payouts) {
      if (!payout.stripeTransferId) continue;

      // Calculate proportional reversal amount
      const reversalAmount = Math.round(payout.amount * newRefundPercentage * 100) / 100;

      if (reversalAmount <= 0) continue;

      try {
        // Get the transfer to check current state
        const transfer = await stripe.transfers.retrieve(payout.stripeTransferId);

        // Calculate how much can still be reversed
        const alreadyReversed = (transfer.amount_reversed || 0) / 100;
        const transferAmount = transfer.amount / 100;
        const remainingReversible = transferAmount - alreadyReversed;

        if (remainingReversible <= 0) {
          // Transfer already fully reversed
          continue;
        }

        // Don't reverse more than what's available
        const actualReversalAmount = Math.min(reversalAmount, remainingReversible);
        const reversalAmountCents = Math.round(actualReversalAmount * 100);

        if (reversalAmountCents <= 0) continue;

        // Create transfer reversal
        const reversal = await stripe.transfers.createReversal(payout.stripeTransferId, {
          amount: reversalAmountCents,
          metadata: {
            reason: 'customer_refund',
            orderId: orderId,
            chargeId: charge.id,
            refundPercentage: (newRefundPercentage * 100).toFixed(1)
          }
        });

        transfersReversed.push({
          transferId: payout.stripeTransferId,
          reversalId: reversal.id,
          amount: actualReversalAmount,
          artistId: payout.artistId,
          artistName: payout.artistName
        });

        totalReversed += actualReversalAmount;

        // Transfer reversed successfully

        // Update payout record
        const currentReversed = payout.reversedAmount || 0;
        const newTotalReversed = currentReversed + actualReversalAmount;
        const isFullyReversed = newTotalReversed >= payout.amount * 0.99;

        await updateDocument('payouts', payout.id, {
          status: isFullyReversed ? 'reversed' : 'partially_reversed',
          reversedAmount: newTotalReversed,
          reversedAt: new Date().toISOString(),
          reversalReason: 'customer_refund',
          refundChargeId: charge.id,
          updatedAt: new Date().toISOString()
        });

        // Update artist's total earnings
        if (payout.artistId) {
          const artist = artistMap.get(payout.artistId as string) || null;
          if (artist) {
            await updateDocument('artists', payout.artistId, {
              totalEarnings: Math.max(0, (artist.totalEarnings || 0) - actualReversalAmount),
              updatedAt: new Date().toISOString()
            });
          }
        }

      } catch (reversalError: unknown) {
        const reversalMessage = reversalError instanceof Error ? reversalError.message : String(reversalError);
        log.error('[Stripe Webhook] Failed to reverse transfer:', payout.stripeTransferId, reversalMessage);

        // Record failed reversal for manual review
        transfersReversed.push({
          transferId: payout.stripeTransferId,
          error: reversalMessage,
          amount: reversalAmount,
          artistId: payout.artistId,
          artistName: payout.artistName,
          failed: true
        });
      }
    }

    // Also cancel any pending payouts
    const pendingPayouts = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
      ],
      limit: 50
    });

    for (const pending of pendingPayouts) {
      if (isFullRefund) {
        // Full refund - cancel entirely
        await updateDocument('pendingPayouts', pending.id, {
          status: 'cancelled',
          cancelledReason: 'order_refunded',
          updatedAt: new Date().toISOString()
        });
      } else {
        // Partial refund - reduce amount proportionally
        const reducedAmount = pending.amount * (1 - newRefundPercentage);
        await updateDocument('pendingPayouts', pending.id, {
          amount: Math.round(reducedAmount * 100) / 100,
          originalAmount: pending.amount,
          reducedByRefund: true,
          refundPercentage: newRefundPercentage,
          updatedAt: new Date().toISOString()
        });
      }
    }

    // Create refund record
    await addDocument('refunds', {
      stripeChargeId: charge.id,
      stripePaymentIntentId: paymentIntentId,
      orderId: orderId,
      orderNumber: order.orderNumber || '',
      totalAmount: totalAmount,
      amountRefunded: refundedAmount,
      newRefundAmount: newRefundAmount,
      refundPercentage: refundPercentage,
      isFullRefund: isFullRefund,
      transfersReversed: transfersReversed,
      totalReversed: totalReversed,
      pendingPayoutsAffected: pendingPayouts.length,
      createdAt: new Date().toISOString()
    });

    // Update order status
    await updateDocument('orders', orderId, {
      refundStatus: isFullRefund ? 'fully_refunded' : 'partially_refunded',
      refundAmount: refundedAmount,
      refundedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    log.info('[Stripe Webhook] \u2713 Refund processed. Reversed', totalReversed, 'GBP from', transfersReversed.filter((t: Record<string, unknown>) => !t.failed).length, 'transfers');

    // Send email notifications to affected artists
    for (const reversal of transfersReversed) {
      if (reversal.failed) continue;

      // Get artist email
      const artist = artistMap.get(reversal.artistId as string) || null;
      if (artist?.email) {
        // Find original payout amount
        const payout = payouts.find((p: Record<string, unknown>) => p.stripeTransferId === reversal.transferId);
        const originalAmount = payout?.amount || reversal.amount;

        sendRefundNotificationEmail(
          artist.email,
          reversal.artistName || artist.artistName,
          reversal.amount,
          originalAmount,
          order.orderNumber || orderId.slice(-6).toUpperCase(),
          isFullRefund,
          env
        ).catch(err => log.error('[Stripe Webhook] Failed to send refund notification email:', err));
      }
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Stripe Webhook] Error handling refund:', message);
  }
}
