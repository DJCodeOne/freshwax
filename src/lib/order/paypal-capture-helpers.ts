// src/lib/order/paypal-capture-helpers.ts
// Helper functions extracted from capture-order.ts
// — merch royalty processing, ledger recording enrichment, credit deduction

import { getDocument, addDocument, updateDocument, atomicIncrement, arrayUnion } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('[paypal-capture]');

// ============================================
// MERCH ROYALTIES
// ============================================

// Process merch royalties - records brand royalties to D1 and Firebase
// This is capture-order-specific logic (not duplicated in capture-redirect)
export async function processMerchRoyalties(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, items, env } = params;

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
          log.info('[PayPal] Royalty recorded:', brandName, royaltyAmount);
        } catch (d1Err: unknown) {
          log.error('[PayPal] D1 royalty record failed:', d1Err);
        }
      }

      // Update brand's pending balance in Firebase
      try {
        await atomicIncrement('merch-suppliers', brandAccountId, {
          pendingBalance: royaltyAmount,
        });
      } catch (fbErr: unknown) {
        log.error('[PayPal] Failed to update brand pending balance:', fbErr);
      }
    }
  } catch (error: unknown) {
    log.error('[PayPal] processMerchSupplierPayments error:', error);
    // Don't throw - order was created, royalties can be retried
  }
}

// ============================================
// LEDGER ENRICHMENT
// ============================================

// Enrich order items with seller info for ledger recording
// Batch-fetches releases, merch, users, and artists to avoid N+1
export async function enrichItemsForLedger(
  itemsList: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  // Collect unique release IDs
  const ledgerReleaseIds = new Set<string>();
  for (const item of itemsList) {
    const releaseId = item.releaseId || item.productId || item.id;
    if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
      ledgerReleaseIds.add(releaseId as string);
    }
  }

  // Collect unique merch product IDs
  const ledgerMerchIds = new Set<string>();
  for (const item of itemsList) {
    if (item.type === 'merch' && item.productId) {
      ledgerMerchIds.add(item.productId as string);
    }
  }

  // Batch-fetch releases and merch in parallel
  // Use Promise.allSettled so a failed batch doesn't block the entire ledger enrichment
  const [ledgerReleaseResult, ledgerMerchResult] = await Promise.allSettled([
    Promise.all([...ledgerReleaseIds].map(async (id) => {
      const doc = await getDocument('releases', id).catch(() => null);
      return [id, doc] as const;
    })),
    Promise.all([...ledgerMerchIds].map(async (id) => {
      const doc = await getDocument('merch', id).catch(() => null);
      return [id, doc] as const;
    }))
  ]);
  const ledgerReleaseEntries = ledgerReleaseResult.status === 'fulfilled' ? ledgerReleaseResult.value : [];
  const ledgerMerchEntries = ledgerMerchResult.status === 'fulfilled' ? ledgerMerchResult.value : [];
  if (ledgerReleaseResult.status === 'rejected') {
    log.error('[PayPal] Ledger release batch fetch failed', { error: ledgerReleaseResult.reason });
  }
  if (ledgerMerchResult.status === 'rejected') {
    log.error('[PayPal] Ledger merch batch fetch failed', { error: ledgerMerchResult.reason });
  }
  const ledgerReleaseMap = new Map(ledgerReleaseEntries.filter(([, doc]) => doc));
  const ledgerMerchMap = new Map(ledgerMerchEntries.filter(([, doc]) => doc));

  // Collect submitterIds from merch items that need user/artist email lookup
  const submitterLookupIds = new Set<string>();
  for (const item of itemsList) {
    if (item.type === 'merch' && item.productId) {
      const merch = ledgerMerchMap.get(item.productId as string);
      if (merch) {
        const sid = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy;
        const hasEmail = merch.email || merch.sellerEmail;
        if (!hasEmail && sid) submitterLookupIds.add(sid as string);
      }
    }
  }

  // Batch-fetch users and artists for submitter email resolution
  // Use Promise.allSettled so a failed batch doesn't block the entire ledger enrichment
  const [submitterUserResult, submitterArtistResult] = await Promise.allSettled([
    Promise.all([...submitterLookupIds].map(async (id) => {
      const doc = await getDocument('users', id).catch(() => null);
      return [id, doc] as const;
    })),
    Promise.all([...submitterLookupIds].map(async (id) => {
      const doc = await getDocument('artists', id).catch(() => null);
      return [id, doc] as const;
    }))
  ]);
  const submitterUserEntries = submitterUserResult.status === 'fulfilled' ? submitterUserResult.value : [];
  const submitterArtistEntries = submitterArtistResult.status === 'fulfilled' ? submitterArtistResult.value : [];
  if (submitterUserResult.status === 'rejected') {
    log.error('[PayPal] Submitter user batch fetch failed', { error: submitterUserResult.reason });
  }
  if (submitterArtistResult.status === 'rejected') {
    log.error('[PayPal] Submitter artist batch fetch failed', { error: submitterArtistResult.reason });
  }
  const submitterUserMap = new Map(submitterUserEntries.filter(([, doc]) => doc));
  const submitterArtistMap = new Map(submitterArtistEntries.filter(([, doc]) => doc));

  // Enrich items with seller info using pre-fetched data
  return itemsList.map((item: Record<string, unknown>) => {
    const releaseId = item.releaseId || item.productId || item.id;
    let submitterId = null;
    let submitterEmail = null;
    let artistName = item.artist || item.artistName || null;

    // Look up release to get submitter info
    if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
      const release = ledgerReleaseMap.get(releaseId as string);
      if (release) {
        submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
        submitterEmail = release.email || release.submitterEmail || release.metadata?.email || null;
        artistName = release.artistName || release.artist || artistName;
      }
    }

    // For merch items, look up the merch document for seller info
    if (item.type === 'merch' && item.productId) {
      const merch = ledgerMerchMap.get(item.productId as string);
      if (merch) {
        submitterId = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy || null;
        submitterEmail = merch.email || merch.sellerEmail || null;
        artistName = merch.sellerName || merch.supplierName || merch.brandName || artistName;

        // If no email on product, check pre-fetched user/artist data
        if (!submitterEmail && submitterId) {
          const userData = submitterUserMap.get(submitterId as string);
          if (userData?.email) {
            submitterEmail = userData.email;
          } else {
            const artistData = submitterArtistMap.get(submitterId as string);
            if (artistData?.email) {
              submitterEmail = artistData.email;
            }
          }
        }
      }
    }

    return {
      ...item,
      submitterId,
      submitterEmail,
      artistName
    };
  });
}

// ============================================
// CREDIT DEDUCTION
// ============================================

// Deduct applied credit from user's balance atomically
export async function deductAppliedCredit(params: {
  userId: string;
  appliedCredit: number;
  orderId: string;
  orderNumber?: string;
}) {
  const { userId, appliedCredit, orderId, orderNumber } = params;

  try {
    const creditData = await getDocument('userCredits', userId);
    if (creditData && creditData.balance >= appliedCredit) {
      const now = new Date().toISOString();

      // Atomically decrement the balance to prevent race conditions
      await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

      // Create transaction record (append separately)
      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newBalance = creditData.balance - appliedCredit;
      const transaction = {
        id: transactionId,
        type: 'purchase',
        amount: -appliedCredit,
        description: `Applied to order ${orderNumber || orderId}`,
        orderId,
        orderNumber,
        createdAt: now,
        balanceAfter: newBalance
      };

      // Update userCredits transactions + users document in parallel (different documents)
      await Promise.all([
        // Atomic arrayUnion prevents lost transactions under concurrent writes
        arrayUnion('userCredits', userId, 'transactions', [transaction], {
          lastUpdated: now
        }),
        // Update user document — atomicIncrement + updateDocument must be sequential
        // (same document) but can run in parallel with the arrayUnion above
        atomicIncrement('users', userId, { creditBalance: -appliedCredit })
          .then(() => updateDocument('users', userId, { creditUpdatedAt: now }))
      ]);

      // Credit deducted atomically
    } else {
      log.warn('[PayPal] Insufficient credit balance for deduction');
    }
  } catch (creditErr: unknown) {
    log.error('[PayPal] Failed to deduct credit:', creditErr);
    // Don't fail the order, just log the error
  }
}
