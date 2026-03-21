// src/lib/order/refund.ts
// Stock refund logic for cancelled/returned orders

import { getDocument, getDocumentsBatch, updateDocument, addDocument, clearCache, updateDocumentConditional, atomicIncrement } from '../firebase-rest';
import { d1UpsertMerch } from '../d1-catalog';
import { log } from './types';
import type { CartItem, VariantStockEntry } from './types';

// Refund stock when order is cancelled
export async function refundOrderStock(orderId: string, items: CartItem[], orderNumber: string, idToken?: string, env?: Record<string, unknown>): Promise<{ failedRefunds: Array<{ item: string; type: string; error: string }> }> {
  const now = new Date().toISOString();
  const failedRefunds: Array<{ item: string; type: string; error: string }> = [];

  // Batch fetch merch products and releases to avoid N+1 queries
  const merchIds = [...new Set(items.filter(i => i.type === 'merch' && i.productId).map(i => i.productId!))];
  const releaseIds = [...new Set(items.filter(i => i.type === 'vinyl' && (i.releaseId || i.productId)).map(i => (i.releaseId || i.productId)!))];
  const [merchMap, releaseMap] = await Promise.all([
    merchIds.length > 0 ? getDocumentsBatch('merch', merchIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
    releaseIds.length > 0 ? getDocumentsBatch('releases', releaseIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
  ]);

  for (const item of items) {
    // Refund merch stock
    if (item.type === 'merch' && item.productId) {
      try {
        log.info('[order-utils] Refunding merch stock for:', item.name, 'qty:', item.quantity);

        const productData = merchMap.get(item.productId) || null;

        if (productData) {
          const variantStock = productData.variantStock || {};
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;

          // Exact match only - no heuristic guessing to avoid refunding wrong variant
          if (!variantStock[variantKey]) {
            log.error('[order-utils] Refund: variant key not found:', variantKey, 'for item:', item.name, 'available keys:', Object.keys(variantStock));
          }

          const variant = variantStock[variantKey];

          if (variant) {
            const previousStock = variant.stock || 0;
            const newStock = previousStock + (item.quantity || 1);

            variant.stock = newStock;
            variant.sold = Math.max(0, (variant.sold || 0) - (item.quantity || 1));
            variantStock[variantKey] = variant;

            let totalStock = 0;
            let totalSold = 0;
            Object.values(variantStock).forEach((v: unknown) => {
              const variant = v as VariantStockEntry;
              totalStock += variant.stock || 0;
              totalSold += variant.sold || 0;
            });

            // Use conditional update if available for concurrency safety
            if (productData._updateTime) {
              await updateDocumentConditional('merch', item.productId, {
                variantStock: variantStock,
                totalStock: totalStock,
                soldStock: totalSold,
                isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                isOutOfStock: totalStock === 0,
                updatedAt: now
              }, productData._updateTime);
            } else {
              await updateDocument('merch', item.productId, {
                variantStock: variantStock,
                totalStock: totalStock,
                soldStock: totalSold,
                isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                isOutOfStock: totalStock === 0,
                updatedAt: now
              });
            }

            // Record refund movement
            await addDocument('merch-stock-movements', {
              productId: item.productId,
              productName: item.name,
              sku: productData.sku,
              variantKey: variantKey,
              variantSku: variant.sku,
              type: 'return',
              quantity: item.quantity || 1,
              stockDelta: item.quantity || 1,
              previousStock: previousStock,
              newStock: newStock,
              orderId: orderId,
              orderNumber: orderNumber,
              notes: 'Order cancelled - ' + orderNumber,
              createdAt: now,
              createdBy: 'system'
            }, idToken);

            log.info('[order-utils] ✓ Merch stock refunded:', item.name, previousStock, '->', newStock);

            // Sync to D1
            const db = env?.DB;
            if (db) {
              try {
                clearCache(`doc:merch:${item.productId}`);
                const updatedProduct = await getDocument('merch', item.productId);
                if (updatedProduct) {
                  await d1UpsertMerch(db, item.productId, updatedProduct);
                  log.info('[order-utils] ✓ D1 synced after refund:', item.name);
                }
              } catch (d1Error: unknown) {
                log.error('[order-utils] D1 sync failed (non-critical):', d1Error);
              }
            }
          }
        }
      } catch (refundErr: unknown) {
        log.error('[order-utils] Merch refund error:', refundErr);
        failedRefunds.push({ item: item.name || item.productId, type: 'merch', error: refundErr instanceof Error ? refundErr.message : String(refundErr) });
      }
    }

    // Refund vinyl stock
    if (item.type === 'vinyl' && (item.releaseId || item.productId)) {
      const releaseId = item.releaseId || item.productId;
      try {
        log.info('[order-utils] Refunding vinyl stock for:', item.name, 'qty:', item.quantity);

        const releaseData = releaseMap.get(releaseId) || null;

        if (releaseData) {
          const previousStock = releaseData.vinylStock || 0;
          const qty = item.quantity || 1;
          const newStock = previousStock + qty;

          // Atomic increment for stock restoration
          await atomicIncrement('releases', releaseId, {
            vinylStock: qty,
            vinylSold: -qty
          });

          // Sync vinylRecordCount display field
          await updateDocument('releases', releaseId, {
            vinylRecordCount: String(newStock),
            updatedAt: now
          });

          await addDocument('vinyl-stock-movements', {
            releaseId: releaseId,
            releaseName: item.name || releaseData.releaseName,
            type: 'return',
            quantity: item.quantity || 1,
            stockDelta: item.quantity || 1,
            previousStock: previousStock,
            newStock: newStock,
            orderId: orderId,
            orderNumber: orderNumber,
            notes: 'Order cancelled - ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);

          log.info('[order-utils] ✓ Vinyl stock refunded:', item.name, previousStock, '->', newStock);
        }
      } catch (refundErr: unknown) {
        log.error('[order-utils] Vinyl refund error:', refundErr);
        failedRefunds.push({ item: item.name || releaseId, type: 'vinyl', error: refundErr instanceof Error ? refundErr.message : String(refundErr) });
      }
    }

    // Restore vinyl crates listings
    if (item.type === 'vinyl' && item.sellerId && !item.releaseId) {
      const listingId = item.id || item.productId;
      if (listingId) {
        try {
          await updateDocument('vinylListings', listingId, {
            status: 'published',
            soldAt: null,
            soldOrderNumber: null,
            soldOrderId: null,
            soldTo: null,
            updatedAt: now
          });
          log.info('[order-utils] ✓ Vinyl crates listing restored:', listingId);
        } catch (restoreErr: unknown) {
          log.error('[order-utils] Failed to restore vinyl crates listing:', restoreErr);
          failedRefunds.push({ item: item.name || listingId, type: 'vinyl-crates', error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) });
        }
      }
    }
  }

  // Report any failed refunds
  if (failedRefunds.length > 0) {
    log.error('[order-utils] CRITICAL: Failed to refund', failedRefunds.length, 'item(s) for order', orderNumber, ':', JSON.stringify(failedRefunds));
  }

  return { failedRefunds };
}
