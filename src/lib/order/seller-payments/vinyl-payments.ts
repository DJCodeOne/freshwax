// src/lib/order/seller-payments/vinyl-payments.ts
// Handles vinyl crate seller payouts via Stripe Connect or PayPal

import Stripe from 'stripe';
import { getDocument, addDocument, updateDocument, atomicIncrement } from '../../firebase-rest';
import { createLogger } from '../../api-utils';
import { getProcessingFee } from './types';
import type { SellerPaymentParams } from './types';

const log = createLogger('[seller-payments]');

// Process vinyl crate seller payments via Stripe Connect or PayPal
export async function processVinylCrateSellerPayments(params: SellerPaymentParams) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env, paymentMethod, actualProcessingFee } = params;
  const prefix = params.logPrefix || '[PayPal]';
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
  // Sellers bear the REAL processor fee when the caller provides it
  const totalProcessingFeeForOrder = (typeof actualProcessingFee === 'number' && actualProcessingFee >= 0)
    ? actualProcessingFee
    : getProcessingFee(orderSubtotal, paymentMethod);

  const { createPayout, getPayPalConfig } = await import('../../paypal-payouts');
  const paypalConfig = getPayPalConfig(env);

  try {
    // Filter to only vinyl crate items. A crate is defined by the ABSENCE of a
    // releaseId — guard against an item that carries both releaseId and sellerId
    // being paid as BOTH a label release (artist-payments) and a crate seller.
    const crateItems = items.filter(item =>
      !item.releaseId && (
        item.type === 'crate' ||
        item.type === 'vinyl-crate' ||
        item.crateListingId ||
        item.sellerId
      )
    );

    if (crateItems.length === 0) {
      // No vinyl crate items - skip seller payments
      return;
    }

    // Processing vinyl crate seller payments

    // Group items by seller
    const sellerPayments: Record<string, {
      sellerId: string;
      sellerName: string;
      sellerEmail: string;
      stripeConnectId: string | null;
      paypalEmail: string | null;
      payoutMethod: string | null;
      amount: number;
      shippingAmount: number;
      items: string[];
    }> = {};

    // Collect unique listing IDs that need fetching (items without a sellerId)
    const listingIds = new Set<string>();
    for (const item of crateItems) {
      if (!item.sellerId && (item.crateListingId || item.listingId)) {
        listingIds.add((item.crateListingId || item.listingId) as string);
      }
    }

    // Batch-fetch all crate listings in parallel
    const listingEntries = await Promise.all(
      [...listingIds].map(async (id) => {
        const doc = await getDocument('crateListings', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const listingMap = new Map(listingEntries.filter(([, doc]) => doc));

    // Resolve sellerIds for all crate items, then collect unique seller IDs
    const sellerIdSet = new Set<string>();
    const itemSellerIds: (string | null)[] = [];
    for (const item of crateItems) {
      let sellerId = item.sellerId as string | null;
      if (!sellerId) {
        const listingId = (item.crateListingId || item.listingId) as string | undefined;
        if (listingId) {
          const listing = listingMap.get(listingId);
          if (listing) {
            sellerId = (listing.sellerId || listing.userId) as string | null;
          }
        }
      }
      itemSellerIds.push(sellerId || null);
      if (sellerId) sellerIdSet.add(sellerId);
    }

    // Batch-fetch all sellers (users) in parallel
    const sellerEntries = await Promise.all(
      [...sellerIdSet].map(async (id) => {
        const doc = await getDocument('users', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const sellerMap = new Map(sellerEntries.filter(([, doc]) => doc));

    for (let i = 0; i < crateItems.length; i++) {
      const item = crateItems[i];
      const sellerId = itemSellerIds[i];

      if (!sellerId) {
        // No seller ID for crate item
        continue;
      }

      const seller = sellerMap.get(sellerId) || null;
      if (!seller) continue;

      // Calculate seller share (same structure as releases)
      // 1% Fresh Wax fee + payment processor fees
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: payment-method-aware (Stripe 1.4%+20p / PayPal 2.9%+30p),
      // computed once for the order then split equally per item.
      const processingFeePerSeller = totalProcessingFeeForOrder / totalItemCount;
      // Seller ships the record themselves — they receive 100% of the
      // shipping the buyer paid for this listing, on top of the item share
      const crateShipping = ((item.cratesShippingCost as number) || 0) * (item.quantity || 1);
      const sellerShare = itemTotal + crateShipping - freshWaxFee - processingFeePerSeller;

      // Group by seller
      if (!sellerPayments[sellerId]) {
        sellerPayments[sellerId] = {
          sellerId,
          sellerName: seller.displayName || seller.name || 'Seller',
          sellerEmail: seller.email || '',
          stripeConnectId: seller.stripeConnectId || null,
          paypalEmail: seller.paypalEmail || null,
          payoutMethod: seller.payoutMethod || null,
          amount: 0,
          shippingAmount: 0,
          items: []
        };
      }

      sellerPayments[sellerId].amount += sellerShare;
      // Seller receives 100% of the postage — tracked separately so payout
      // records/statements can itemise the shipping portion.
      sellerPayments[sellerId].shippingAmount += crateShipping;
      sellerPayments[sellerId].items.push(item.name || item.title || 'Vinyl');
    }

    // Processing vinyl crate seller payments

    // Process each seller payment
    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];

      if (payment.amount <= 0) continue;

      // Processing seller payment

      // Check preferred payout method
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        // PayPal payout for crate seller - deduct 2% payout fee
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        // Paying crate seller via PayPal

        try {
          const paypalResult = await createPayout(paypalConfig!, {
            email: payment.paypalEmail!,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax vinyl sale payout for order #${orderNumber}`,
            reference: `${orderId}-seller-${payment.sellerId}`
          });

          if (paypalResult.success) {
            await addDocument('crateSellerPayouts', {
              sellerId: payment.sellerId,
              sellerName: payment.sellerName,
              sellerEmail: payment.sellerEmail,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: paypalResult.batchId,
              payoutMethod: 'paypal',
              customerPaymentMethod: 'paypal',
              orderId,
              orderNumber,
              amount: paypalAmount,
              shippingAmount: payment.shippingAmount,
              itemAmount: Math.round((paypalAmount - payment.shippingAmount) * 100) / 100,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              items: payment.items,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            // Atomically update crate seller earnings
            await atomicIncrement('users', payment.sellerId, {
              crateEarnings: paypalAmount,
            });
            await updateDocument('users', payment.sellerId, {
              lastCratePayoutAt: new Date().toISOString()
            });

            // Crate seller PayPal payout created
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: unknown) {
          const paypalMessage = paypalError instanceof Error ? paypalError.message : String(paypalError);
          log.error(`${prefix} Crate seller PayPal payout failed:`, paypalMessage);

          await addDocument('pendingCrateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            paypalEmail: payment.paypalEmail,
            payoutMethod: 'paypal',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: paypalAmount,
            shippingAmount: payment.shippingAmount,
            itemAmount: Math.round((paypalAmount - payment.shippingAmount) * 100) / 100,
            paypalPayoutFee: paypalPayoutFee,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: paypalMessage,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

      } else if (useStripe) {
        // Stripe transfer for crate seller
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100),
            currency: 'gbp',
            destination: payment.stripeConnectId!,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              sellerId: payment.sellerId,
              sellerName: payment.sellerName,
              type: 'vinyl_crate_seller',
              platform: 'freshwax',
              customerPaymentMethod: 'paypal'
            }
          });

          await addDocument('crateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            stripeConnectId: payment.stripeConnectId,
            stripeTransferId: transfer.id,
            payoutMethod: 'stripe',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: payment.amount,
            shippingAmount: payment.shippingAmount,
            itemAmount: Math.round((payment.amount - payment.shippingAmount) * 100) / 100,
            currency: 'gbp',
            status: 'completed',
            items: payment.items,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Atomically update crate seller earnings
          await atomicIncrement('users', payment.sellerId, {
            crateEarnings: payment.amount,
          });
          await updateDocument('users', payment.sellerId, {
            lastCratePayoutAt: new Date().toISOString()
          });

          // Crate seller Stripe transfer created

        } catch (transferError: unknown) {
          const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
          log.error(`${prefix} Crate seller transfer failed:`, transferMessage);

          await addDocument('pendingCrateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            orderId,
            orderNumber,
            amount: payment.amount,
            shippingAmount: payment.shippingAmount,
            itemAmount: Math.round((payment.amount - payment.shippingAmount) * 100) / 100,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: transferMessage,
            customerPaymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        // Seller not connected - store as pending
        // Crate seller not connected - storing pending

        await addDocument('pendingCrateSellerPayouts', {
          sellerId: payment.sellerId,
          sellerName: payment.sellerName,
          sellerEmail: payment.sellerEmail,
          orderId,
          orderNumber,
          amount: payment.amount,
          shippingAmount: payment.shippingAmount,
          itemAmount: Math.round((payment.amount - payment.shippingAmount) * 100) / 100,
          currency: 'gbp',
          status: 'awaiting_connect',
          items: payment.items,
          notificationSent: false,
          customerPaymentMethod: 'paypal',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
  } catch (error: unknown) {
    log.error(`${prefix} processVinylCrateSellerPayments error:`, error);
    throw error;
  }
}
