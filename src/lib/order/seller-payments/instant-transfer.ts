// src/lib/order/seller-payments/instant-transfer.ts
// Sale-time Stripe transfer for artists with an ACTIVE Connect account.
// Mirrors the crate-seller pattern (vinyl-payments.ts) and the Connect
// activation hook's bookkeeping (connect/webhook.ts processPendingPayouts):
// transfer → completed `payouts` record → totalEarnings increment
// (pendingBalance is never touched — the money never pends) → completion
// email. Returns false on ANY failure so the caller falls back to the
// normal pendingPayouts row; a failed instant transfer must never cost the
// artist their payout record.

import Stripe from 'stripe';
import { addDocument, atomicIncrement, updateDocument } from '../../firebase-rest';
import { sendPayoutCompletedEmail } from '../../payout-emails';
import { createLogger } from '../../api-utils';

const log = createLogger('[instant-transfer]');

export interface InstantTransferParams {
  /** The artists/{uid} doc, as already fetched by the payout aggregation */
  artist: Record<string, unknown> | null | undefined;
  artistId: string;
  artistName: string;
  artistEmail: string;
  amount: number;
  itemAmount: number;
  shippingAmount: number;
  orderId: string;
  orderNumber: string;
  customerPaymentMethod: string;
  stripeSecretKey: string | undefined;
  env: Record<string, unknown> | undefined;
}

/** Same test the payouts dashboard uses for "connected". */
export function isConnectActive(artist: Record<string, unknown> | null | undefined): boolean {
  return !!artist
    && typeof artist.stripeConnectId === 'string'
    && artist.stripeConnectId.length > 0
    && artist.stripeConnectStatus === 'active';
}

export async function attemptInstantArtistTransfer(params: InstantTransferParams): Promise<boolean> {
  const {
    artist, artistId, artistName, artistEmail, amount, itemAmount, shippingAmount,
    orderId, orderNumber, customerPaymentMethod, stripeSecretKey, env
  } = params;

  if (!isConnectActive(artist) || !stripeSecretKey) return false;
  const pence = Math.round(amount * 100);
  if (pence < 1) return false;
  const destination = (artist as Record<string, unknown>).stripeConnectId as string;

  try {
    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
    const transfer = await stripe.transfers.create({
      amount: pence,
      currency: 'gbp',
      destination,
      transfer_group: orderId,
      metadata: {
        orderId,
        orderNumber,
        artistId,
        artistName,
        type: 'artist_sale',
        platform: 'freshwax',
        customerPaymentMethod
      }
    });

    const now = new Date().toISOString();
    await addDocument('payouts', {
      artistId,
      artistName,
      artistEmail,
      entityType: 'artist',
      stripeConnectId: destination,
      stripeTransferId: transfer.id,
      payoutMethod: 'stripe',
      orderId,
      orderNumber,
      amount,
      itemAmount,
      shippingAmount,
      currency: 'gbp',
      status: 'completed',
      customerPaymentMethod,
      createdAt: now,
      updatedAt: now,
      completedAt: now
    });

    try {
      await atomicIncrement('artists', artistId, { totalEarnings: amount });
      await updateDocument('artists', artistId, { lastPayoutAt: now, updatedAt: now });
    } catch (balanceError: unknown) {
      log.warn(`Post-transfer earnings update failed for ${artistId}`, balanceError);
    }

    if (artistEmail) {
      try {
        await sendPayoutCompletedEmail(artistEmail, artistName, amount, orderNumber, env as Parameters<typeof sendPayoutCompletedEmail>[4]);
      } catch (emailError: unknown) {
        log.warn('Payout completed email failed:', emailError);
      }
    }

    log.info(`Instant transfer ${transfer.id}: £${amount.toFixed(2)} → ${artistName} (${orderNumber})`);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Instant transfer failed for ${artistName} (${orderNumber}) — falling back to pending payout:`, message);
    return false;
  }
}
