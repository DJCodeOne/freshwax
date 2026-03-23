// src/lib/stripe-webhook/seller-enrichment.ts
// Enriches order items with seller/artist info for sales ledger recording

import { getDocument } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-seller-enrichment');

/**
 * Enrich order items with seller info (submitterId, submitterEmail, artistName)
 * by looking up releases and merch products in Firestore.
 * Uses Promise.allSettled so a single failed enrichment doesn't block the sales ledger.
 */
export async function enrichItemsWithSellerInfo(
  items: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const enrichmentResults = await Promise.allSettled(items.map(async (item: Record<string, unknown>) => {
    const releaseId = item.releaseId || item.productId || item.id;
    let submitterId = null;
    let submitterEmail = null;
    let artistName = item.artist || item.artistName || null;

    // Look up release to get submitter info
    if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
      try {
        const release = await getDocument('releases', releaseId as string);
        if (release) {
          submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
          // Email field - release stores it as 'email', not 'submitterEmail'
          submitterEmail = release.email || release.submitterEmail || release.metadata?.email || null;
          artistName = release.artistName || release.artist || artistName;
        }
      } catch (lookupErr: unknown) {
        log.error(`[seller-enrichment] Failed to lookup release ${releaseId}:`, lookupErr);
      }
    }

    // For merch items, look up the merch document for seller info
    if (item.type === 'merch' && item.productId) {
      try {
        const merch = await getDocument('merch', item.productId as string);
        if (merch) {
          // Check supplierId first (set by assign-seller), then sellerId, then fallbacks
          submitterId = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy || null;
          submitterEmail = merch.email || merch.sellerEmail || null;
          artistName = merch.sellerName || merch.supplierName || merch.brandName || artistName;

          // If no email on product, look up seller in users/artists collection
          if (!submitterEmail && submitterId) {
            try {
              const userData = await getDocument('users', submitterId as string);
              if (userData?.email) {
                submitterEmail = userData.email;
              } else {
                const artistData = await getDocument('artists', submitterId as string);
                if (artistData?.email) {
                  submitterEmail = artistData.email;
                }
              }
            } catch (e: unknown) {
              // Ignore lookup errors
            }
          }
        }
      } catch (lookupErr: unknown) {
        log.error(`[seller-enrichment] Failed to lookup merch ${item.productId}:`, lookupErr);
      }
    }

    return {
      ...item,
      submitterId,
      submitterEmail,
      artistName
    };
  }));

  return enrichmentResults.map((result, i) =>
    result.status === 'fulfilled' ? result.value : { ...items[i], submitterId: null, submitterEmail: null, artistName: items[i].artist || items[i].artistName || null }
  );
}
