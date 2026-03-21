// src/lib/stripe-webhook/vinyl-crate-payments.ts
// Vinyl crate seller payment processing for Stripe webhook

import Stripe from 'stripe';
import { getDocument, addDocument, updateDocument } from '../firebase-rest';
import { getPayPalConfig } from '../paypal-payouts';
import { createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-vinyl-crate');

// Process vinyl crate seller payments via Stripe Connect
export async function processVinylCrateSellerPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Filter to only vinyl crate items (type: 'crate' or 'vinyl-crate' or has crateListingId)
    const crateItems = items.filter(item =>
      item.type === 'crate' ||
      item.type === 'vinyl-crate' ||
      item.crateListingId ||
      item.sellerId // Items with a seller are from crates
    );

    if (crateItems.length === 0) {
      return;
    }

    // Group items by seller
    const sellerPayments: Record<string, {
      sellerId: string;
      sellerName: string;
      sellerEmail: string;
      stripeConnectId: string | null;
      paypalEmail: string | null;
      payoutMethod: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Cache for crate listing lookups
    const listingCache: Record<string, unknown> = {};
    // Cache for seller lookups
    const sellerCache: Record<string, Record<string, unknown>> = {};

    for (const item of crateItems) {
      // Get the seller info
      let sellerId = item.sellerId;
      let listingId = item.crateListingId || item.listingId;

      // If no sellerId, try to get from listing
      if (!sellerId && listingId) {
        let listing = listingCache[listingId];
        if (!listing) {
          listing = await getDocument('crateListings', listingId);
          if (listing) {
            listingCache[listingId] = listing;
          }
        }
        if (listing) {
          sellerId = listing.sellerId || listing.userId;
        }
      }

      if (!sellerId) {
        // No seller ID for crate item
        continue;
      }

      // Look up seller (user) for Connect details
      let seller = sellerCache[sellerId] || null;
      if (!seller) {
        try {
          seller = await getDocument('users', sellerId);
          if (seller) sellerCache[sellerId] = seller;
        } catch (e: unknown) {
          // Seller user not found
        }
      }

      if (!seller) continue;

      // Calculate seller share (same structure as releases)
      // 1% Fresh Wax fee + payment processor fees
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const sellerShare = itemTotal - freshWaxFee - processingFeePerSeller;

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
          items: []
        };
      }

      sellerPayments[sellerId].amount += sellerShare;
      sellerPayments[sellerId].items.push(item.name || item.title || 'Vinyl');
    }

    // Process vinyl crate seller payments

    // Process each seller payment
    const sellerPaypalConfig = getPayPalConfig(env);

    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];

      if (payment.amount <= 0) continue;

      // Process seller payment

      // NOTE: Automatic payouts disabled - all crate seller payouts are manual for now
      // Always create pending payout for manual processing
      // Create pending payout for crate seller

      await addDocument('pendingCrateSellerPayouts', {
        sellerId: payment.sellerId,
        sellerName: payment.sellerName,
        sellerEmail: payment.sellerEmail,
        paypalEmail: payment.paypalEmail,
        stripeConnectId: payment.stripeConnectId,
        payoutMethod: payment.payoutMethod,
        orderId,
        orderNumber,
        amount: payment.amount,
        currency: 'gbp',
        status: 'pending',
        items: payment.items,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update seller's pending crate balance
      const seller = await getDocument('users', payment.sellerId);
      if (seller) {
        await updateDocument('users', payment.sellerId, {
          pendingCrateBalance: (seller.pendingCrateBalance || 0) + payment.amount
        });
      }

      // Pending crate seller payout created
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Stripe Webhook] Error processing vinyl crate seller payments:', message);
    // Don't throw - order was created, payments can be retried
  }
}
