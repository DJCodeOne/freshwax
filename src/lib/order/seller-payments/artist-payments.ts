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
    // Group items by artist. When a release defines `payoutSplits` (array of
    // { artistId, percentage } summing to 100), the artist share for that
    // release's items is fanned out across multiple recipients instead of
    // routed wholesale to release.artistId. Used for split-ownership EPs
    // like Code One & Bakkus 'Jungle Disorder' (50/50 across two accounts).
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

    // Helper: read & validate a release's split config, or return null when
    // it should fall back to the single-artist behaviour.
    const getSplits = (release: Record<string, unknown> | undefined): Array<{ artistId: string; percentage: number }> | null => {
      const raw = (release as { payoutSplits?: unknown } | undefined)?.payoutSplits;
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const cleaned = raw
        .map((s) => s as { artistId?: unknown; percentage?: unknown })
        .filter((s) => typeof s.artistId === 'string' && typeof s.percentage === 'number' && s.percentage > 0)
        .map((s) => ({ artistId: s.artistId as string, percentage: s.percentage as number }));
      if (cleaned.length === 0) return null;
      const total = cleaned.reduce((sum, s) => sum + s.percentage, 0);
      // Allow tiny rounding errors but reject anything that's clearly wrong
      if (Math.abs(total - 100) > 0.01) {
        log.warn(`${prefix} payoutSplits don't sum to 100 (got ${total}); falling back to single-artist routing`);
        return null;
      }
      return cleaned;
    };

    // Collect unique artist IDs from resolved releases (including split recipients)
    const artistIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;
      const release = releaseMap.get(releaseId as string);
      if (!release) continue;
      const splits = getSplits(release);
      if (splits) {
        for (const s of splits) artistIds.add(s.artistId);
      } else {
        const aid = item.artistId || release.artistId || release.userId;
        if (aid) artistIds.add(aid as string);
      }
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

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Artist sets full price, fees deducted from that
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const artistShare = itemTotal - freshWaxFee - processingFeePerSeller;

      // Build the recipient list — either explicit splits from the release
      // doc or a single-recipient list using the release's artistId.
      const splits = getSplits(release);
      const recipients = splits
        ? splits.map((s) => ({ artistId: s.artistId, share: artistShare * (s.percentage / 100) }))
        : (() => {
            const aid = (item.artistId || release.artistId || release.userId) as string;
            return aid ? [{ artistId: aid, share: artistShare }] : [];
          })();

      if (recipients.length === 0) continue;

      const itemLabel = item.name || item.title || 'Item';

      for (const recipient of recipients) {
        const artist = artistMap.get(recipient.artistId) || null;
        if (!artistPayments[recipient.artistId]) {
          artistPayments[recipient.artistId] = {
            artistId: recipient.artistId,
            artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
            artistEmail: artist?.email || release.artistEmail || '',
            amount: 0,
            items: []
          };
        }
        artistPayments[recipient.artistId].amount += recipient.share;
        artistPayments[recipient.artistId].items.push(itemLabel);
      }
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
