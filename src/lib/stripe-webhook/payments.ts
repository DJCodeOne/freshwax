// src/lib/stripe-webhook/payments.ts
// Artist and supplier payment processing for Stripe webhook

import { getDocument, queryCollection, addDocument, updateDocument, atomicIncrement } from '../firebase-rest';
import { formatPrice } from '../format-utils';
import { createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-payments');

export function getCountryName(code: string): string {
  const countryMap: { [key: string]: string } = {
    'GB': 'United Kingdom',
    'IE': 'Ireland',
    'DE': 'Germany',
    'FR': 'France',
    'NL': 'Netherlands',
    'BE': 'Belgium',
    'US': 'United States',
    'CA': 'Canada',
    'AU': 'Australia'
  };
  return countryMap[code] || code;
}

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
export async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  artistShippingBreakdown?: Record<string, { artistId: string; artistName: string; amount: number }> | null;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, artistShippingBreakdown, env } = params;

  try {
    // Group items by artist (using releaseId to look up artist)
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      amount: number;
      shippingAmount?: number;
      items: string[];
    }> = {};

    // Cache for release lookups
    const releaseCache: Record<string, Record<string, unknown>> = {};
    // Cache for artist lookups
    const artistCache: Record<string, Record<string, unknown>> = {};

    for (const item of items) {
      // Skip merch items - they go to suppliers, not artists
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      let release = releaseCache[releaseId];
      if (!release) {
        release = await getDocument('releases', releaseId);
        if (release) releaseCache[releaseId] = release;
      }

      if (!release) continue;

      const artistId = item.artistId || release.artistId || release.userId;
      if (!artistId) continue;

      let artist = artistCache[artistId] || null;
      if (!artist) {
        try {
          artist = await getDocument('artists', artistId);
          if (artist) artistCache[artistId] = artist;
        } catch (e: unknown) {
          // Artist not found
        }
      }

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // 1% Fresh Wax platform fee
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const artistShare = itemTotal - freshWaxFee - processingFeePerSeller;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    // Add shipping fees to artist payments (artists receive 100% of their vinyl shipping)
    if (artistShippingBreakdown) {
      for (const artistId of Object.keys(artistShippingBreakdown)) {
        const shippingInfo = artistShippingBreakdown[artistId];
        if (artistPayments[artistId] && shippingInfo.amount > 0) {
          artistPayments[artistId].amount += shippingInfo.amount;
          artistPayments[artistId].shippingAmount = shippingInfo.amount;
          // Shipping fee added to artist payment
        }
      }
    }

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      const itemAmount = payment.amount - (payment.shippingAmount || 0);

      // Always create pending payout for manual processing
      await addDocument('pendingPayouts', {
        artistId: payment.artistId,
        artistName: payment.artistName,
        artistEmail: payment.artistEmail,
        orderId,
        orderNumber,
        amount: payment.amount,
        itemAmount: itemAmount,
        shippingAmount: payment.shippingAmount || 0,
        currency: 'gbp',
        status: 'pending',
        customerPaymentMethod: 'stripe',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update artist's pending balance atomically
      try {
        await atomicIncrement('artists', payment.artistId, {
          pendingBalance: payment.amount,
        });
        await updateDocument('artists', payment.artistId, {
          updatedAt: new Date().toISOString()
        });
      } catch (e: unknown) {
        // Non-fatal: artist pending balance update failed
      }
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Stripe Webhook] Error processing artist payments:', message);
    // Don't throw - order was created, payments can be retried
  }
}

// Process supplier payments for merch items via Stripe Connect
export async function processSupplierPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, env } = params;

  try {
    // Filter to only merch items
    const merchItems = items.filter(item => item.type === 'merch');

    if (merchItems.length === 0) {
      return;
    }

    const db = env?.DB;

    // Process each merch item for royalty tracking
    for (const item of merchItems) {
      const brandName = (item.brandName || item.categoryName || 'Fresh Wax') as string;
      const brandAccountId = (item.brandAccountId || '') as string;

      // Fresh Wax branded items = no royalty, FW keeps 100%
      if (!brandAccountId || brandName === 'Fresh Wax') {
        continue;
      }

      const itemPrice = (item.price as number) || 0;
      const quantity = (item.quantity as number) || 1;
      const saleTotal = itemPrice * quantity;

      // 10% royalty to brand, 90% to FreshWax
      const royaltyAmount = Math.round(saleTotal * 0.10 * 100) / 100;
      const freshwaxAmount = Math.round((saleTotal - royaltyAmount) * 100) / 100;

      const entryId = `roy_${orderId}_${(item.productId || item.id || Date.now())}_${Math.random().toString(36).substr(2, 6)}`;

      // Record to D1 royalty ledger
      if (db) {
        try {
          const { d1RecordRoyalty } = await import('../d1-catalog');
          await d1RecordRoyalty(db, {
            id: entryId,
            orderId,
            brandAccountId,
            brandName,
            itemId: (item.productId || item.id || '') as string,
            itemName: (item.name || item.title || 'Item') as string,
            quantity,
            saleTotal,
            royaltyPct: 10,
            royaltyAmount,
            freshwaxAmount
          });
          log.info('[Stripe Webhook] Royalty recorded:', brandName, formatPrice(royaltyAmount));
        } catch (d1Err: unknown) {
          log.error('[Stripe Webhook] D1 royalty record failed:', d1Err);
        }
      }

      // Update brand's pending balance in Firebase
      try {
        await atomicIncrement('merch-suppliers', brandAccountId, {
          pendingBalance: royaltyAmount,
        });
      } catch (fbErr: unknown) {
        log.error('[Stripe Webhook] Failed to update brand pending balance:', fbErr);
      }
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Stripe Webhook] Error processing supplier payments:', message);
    // Don't throw - order was created, payments can be retried
  }
}
