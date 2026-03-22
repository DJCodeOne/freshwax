// src/lib/order/seller-payments/artist-payments.ts
// Handles artist royalty payouts — creates pending payouts for manual review

import { getDocument, addDocument, updateDocument, atomicIncrement } from '../../firebase-rest';
import { createLogger } from '../../api-utils';
import type { SellerPaymentParams } from './types';

const log = createLogger('[seller-payments]');

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
export async function processArtistPayments(params: SellerPaymentParams) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal } = params;
  const prefix = params.logPrefix || '[PayPal]';

  try {
    // Group items by artist
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      amount: number;
      items: string[];
    }> = {};

    // Collect unique release IDs
    const releaseIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (releaseId) releaseIds.add(releaseId as string);
    }

    // Batch-fetch all releases in parallel
    const releaseEntries = await Promise.all(
      [...releaseIds].map(async (id) => {
        const doc = await getDocument('releases', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const releaseMap = new Map(releaseEntries.filter(([, doc]) => doc));

    // Collect unique artist IDs from resolved releases
    const artistIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;
      const release = releaseMap.get(releaseId as string);
      if (!release) continue;
      const aid = item.artistId || release.artistId || release.userId;
      if (aid) artistIds.add(aid as string);
    }

    // Batch-fetch all artists in parallel
    const artistEntries = await Promise.all(
      [...artistIds].map(async (id) => {
        const doc = await getDocument('artists', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const artistMap = new Map(artistEntries.filter(([, doc]) => doc));

    for (const item of items) {
      // Skip merch items - they go to suppliers
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      const release = releaseMap.get(releaseId as string);
      if (!release) continue;

      const artistId = (item.artistId || release.artistId || release.userId) as string;
      if (!artistId) continue;

      const artist = artistMap.get(artistId) || null;

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Artist sets full price, fees deducted from that
      // 1% Fresh Wax fee
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

    // Processing artist payouts

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      // Creating pending payout

      // Always create pending payout for manual processing
      await addDocument('pendingPayouts', {
        artistId: payment.artistId,
        artistName: payment.artistName,
        artistEmail: payment.artistEmail,
        orderId,
        orderNumber,
        amount: payment.amount,
        currency: 'gbp',
        status: 'pending',
        customerPaymentMethod: 'paypal',
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
        log.warn(`${prefix} Could not update artist pending balance`);
      }

      // Pending payout created
    }
  } catch (error: unknown) {
    log.error(`${prefix} processArtistPayments error:`, error);
    throw error;
  }
}
