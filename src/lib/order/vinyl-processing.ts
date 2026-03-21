// src/lib/order/vinyl-processing.ts
// Vinyl stock updates and crates marketplace order processing

import { getDocument, getDocumentsBatch, updateDocument, addDocument, setDocument, updateDocumentConditional, atomicIncrement } from '../firebase-rest';
import { sendVinylOrderSellerEmail, sendVinylOrderAdminEmail } from '../vinyl-order-emails';
import { log } from './types';
import type { CartItem } from './types';

// Update stock for vinyl items (atomic)
export async function updateVinylStock(items: CartItem[], orderNumber: string, orderId: string, idToken?: string): Promise<void> {
  const now = new Date().toISOString();

  // Filter to vinyl release items (not crates)
  const vinylItems = items.filter(item =>
    item.type === 'vinyl' && (item.releaseId || item.productId) && !(item.sellerId && !item.releaseId)
  );

  if (vinylItems.length === 0) return;

  // Batch pre-fetch all release docs for reservation check
  const releaseIds = [...new Set(vinylItems.map(item => (item.releaseId || item.productId) as string).filter(Boolean))];
  const preCheckMap = releaseIds.length > 0 ? await getDocumentsBatch('releases', releaseIds) : new Map<string, Record<string, unknown>>();

  for (const item of vinylItems) {
    const releaseId = item.releaseId || item.productId;
    try {
      const qty = item.quantity || 1;
      log.info('[order-utils] Updating vinyl stock for:', item.name, 'qty:', qty);

      // Atomic decrement stock and reserved - prevents race conditions on concurrent purchases
      const incrementFields: Record<string, number> = {
        vinylStock: -qty,
        vinylSold: qty
      };

      // Also clear the reservation counter if it was reserved (use pre-fetched data)
      const preCheck = preCheckMap.get(releaseId as string) || null;
      if (preCheck && (preCheck.vinylReserved ?? 0) > 0) {
        incrementFields.vinylReserved = -Math.min(qty, preCheck.vinylReserved as number);
      }

      await atomicIncrement('releases', releaseId as string, incrementFields);

      // Read AFTER atomic increment to get the actual current stock
      const releaseData = await getDocument('releases', releaseId as string);
      const currentStock = (releaseData?.vinylStock as number) || 0;
      const previousStock = currentStock + qty; // Derive previous from current since we just decremented by qty
      const newStock = currentStock;

      // Sync vinylRecordCount (string field used by frontend display)
      await updateDocument('releases', releaseId as string, {
        vinylRecordCount: String(Math.max(0, newStock)),
        updatedAt: now
      });

      // Record stock movement
      await addDocument('vinyl-stock-movements', {
        releaseId: releaseId,
        releaseName: item.name || releaseData?.releaseName,
        type: 'sell',
        quantity: qty,
        stockDelta: -qty,
        previousStock: previousStock,
        newStock: newStock,
        orderId: orderId,
        orderNumber: orderNumber,
        notes: 'Order ' + orderNumber,
        createdAt: now,
        createdBy: 'system'
      }, idToken);

      log.info('[order-utils] ✓ Vinyl stock updated atomically:', item.name, previousStock, '->', newStock);
    } catch (stockErr: unknown) {
      log.error('[order-utils] Vinyl stock update error:', stockErr);
    }
  }
}

// Process vinyl crates orders (marketplace items from sellers)
// Creates order records for sellers, marks listings as sold, and sends notifications
export async function processVinylCratesOrders(
  items: CartItem[],
  orderNumber: string,
  orderId: string,
  customer: { email: string; firstName: string; lastName: string },
  shipping: Record<string, unknown> | null,
  env?: Record<string, unknown>,
  idToken?: string
): Promise<void> {
  const now = new Date().toISOString();

  // Filter for crates items (have sellerId - these are marketplace items, not new releases)
  const cratesItems = items.filter(item =>
    item.type === 'vinyl' && item.sellerId && !item.releaseId
  );

  if (cratesItems.length === 0) {
    log.info('[order-utils] No vinyl crates items to process');
    return;
  }

  log.info('[order-utils] Processing', cratesItems.length, 'vinyl crates items');

  // Batch pre-fetch all listings and seller data to avoid N+1 queries
  const listingIds = [...new Set(cratesItems.map(item => item.id as string).filter(Boolean))];
  const sellerIds = [...new Set(cratesItems.map(item => item.sellerId as string).filter(Boolean))];

  const [listingMap, vinylSellerMap, legacySellerMap, userMap] = await Promise.all([
    listingIds.length > 0 ? getDocumentsBatch('vinylListings', listingIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
    sellerIds.length > 0 ? getDocumentsBatch('vinylSellers', sellerIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
    sellerIds.length > 0 ? getDocumentsBatch('vinyl-sellers', sellerIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
    sellerIds.length > 0 ? getDocumentsBatch('users', sellerIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
  ]);

  for (const item of cratesItems) {
    try {
      const listingId = item.id;
      const sellerId = item.sellerId;
      const sellerName = item.sellerName || 'Unknown Seller';

      log.info('[order-utils] Processing crates item:', item.title, 'from seller:', sellerName);

      // 1. Mark the listing as sold (with optimistic concurrency to prevent double-sell)
      // Accept both 'published' and 'reserved' status (reserved = in active checkout)
      try {
        const listing = listingMap.get(listingId as string) || null;
        const canSell = listing && (listing.status === 'published' || listing.status === 'reserved');
        if (canSell && listing._updateTime) {
          await updateDocumentConditional('vinylListings', listingId as string, {
            status: 'sold',
            soldAt: now,
            soldOrderNumber: orderNumber,
            soldOrderId: orderId,
            soldTo: customer.email,
            reservedAt: null,
            reservedBy: null,
            updatedAt: now
          }, listing._updateTime as string);
        } else if (listing && listing.status !== 'sold' && !listing._updateTime) {
          log.error('[order-utils] CRITICAL: Listing missing _updateTime, cannot guarantee concurrency protection:', listingId);
          const freshListing = await getDocument('vinylListings', listingId as string);
          const freshCanSell = freshListing && (freshListing.status === 'published' || freshListing.status === 'reserved');
          if (freshCanSell && freshListing._updateTime) {
            await updateDocumentConditional('vinylListings', listingId as string, {
              status: 'sold',
              soldAt: now,
              soldOrderNumber: orderNumber,
              soldOrderId: orderId,
              soldTo: customer.email,
              reservedAt: null,
              reservedBy: null,
              updatedAt: now
            }, freshListing._updateTime as string);
          } else if (freshCanSell) {
            log.error('[order-utils] WARNING: Listing missing _updateTime, using non-conditional update for:', listingId);
            await updateDocument('vinylListings', listingId as string, {
              status: 'sold',
              soldAt: now,
              soldOrderNumber: orderNumber,
              soldOrderId: orderId,
              soldTo: customer.email,
              reservedAt: null,
              reservedBy: null,
              updatedAt: now
            });
          }
        } else {
          log.error('[order-utils] Listing already sold or missing:', listingId);
        }
        log.info('[order-utils] ✓ Listing marked as sold:', listingId);
      } catch (markSoldErr: unknown) {
        if (markSoldErr instanceof Error && markSoldErr.message.includes('CONFLICT')) {
          log.error('[order-utils] Listing was modified concurrently (possible double-sell prevented):', listingId);
        } else {
          log.error('[order-utils] Failed to mark listing as sold:', markSoldErr);
        }
      }

      // 2. Create vinyl order record for the seller
      const vinylOrder = {
        orderId: orderId,
        orderNumber: orderNumber,
        listingId: listingId,
        sellerId: sellerId,
        sellerName: sellerName,
        title: item.title || item.name,
        artist: item.artist,
        price: item.price,
        originalPrice: item.originalPrice || item.price,
        discountPercent: item.discountPercent || 0,
        shippingCost: item.shippingCost || 0,
        format: item.format,
        condition: item.condition,
        image: item.image,
        buyer: {
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          name: `${customer.firstName} ${customer.lastName}`
        },
        shipping: shipping,
        status: 'pending', // Seller needs to ship
        createdAt: now,
        updatedAt: now
      };

      try {
        const vinylOrderId = `vo_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        await setDocument('vinylOrders', vinylOrderId, vinylOrder);
        log.info('[order-utils] ✓ Vinyl order created:', vinylOrderId);
      } catch (orderErr: unknown) {
        log.error('[order-utils] Failed to create vinyl order:', orderErr);
      }

      // 3. Get seller email from pre-fetched data
      let sellerEmail = '';
      try {
        const seller = vinylSellerMap.get(sellerId as string) || legacySellerMap.get(sellerId as string) || null;
        if (seller) {
          sellerEmail = (seller.email as string) || '';
        }
        // Fall back to users collection
        if (!sellerEmail) {
          const user = userMap.get(sellerId as string) || null;
          sellerEmail = (user?.email as string) || '';
        }
      } catch (e: unknown) {
        log.info('[order-utils] Could not fetch seller email');
      }

      // Send seller notification
      if (sellerEmail) {
        try {
          await sendVinylOrderSellerEmail(
            sellerEmail,
            sellerName,
            {
              orderNumber,
              itemTitle: item.title || item.name,
              itemArtist: item.artist,
              price: item.price,
              buyerName: `${customer.firstName} ${customer.lastName}`,
              buyerEmail: customer.email,
              shippingAddress: shipping
            },
            env
          );
          log.info('[order-utils] ✓ Seller email sent to:', sellerEmail);
        } catch (emailErr: unknown) {
          log.error('[order-utils] Seller email failed:', emailErr);
        }
      }

      // Send admin notification
      try {
        await sendVinylOrderAdminEmail(
          {
            orderNumber,
            sellerId,
            sellerName,
            sellerEmail: sellerEmail || 'unknown',
            itemTitle: item.title || item.name,
            itemArtist: item.artist,
            price: item.price,
            buyerName: `${customer.firstName} ${customer.lastName}`,
            buyerEmail: customer.email
          },
          env
        );
        log.info('[order-utils] ✓ Admin email sent');
      } catch (adminEmailErr: unknown) {
        log.error('[order-utils] Admin email failed:', adminEmailErr);
      }

    } catch (err: unknown) {
      log.error('[order-utils] Error processing crates item:', err);
    }
  }
}
