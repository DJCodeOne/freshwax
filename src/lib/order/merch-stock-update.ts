// src/lib/order/merch-stock-update.ts
// Merch stock decrement + supplier stats after a successful order
// Extracted from create-order.ts (pure extraction, zero behavior changes)

import { getDocument, updateDocument, updateDocumentConditional, addDocument, clearCache, atomicIncrement } from '../firebase-rest';
import { d1UpsertMerch } from '../d1-catalog';
import { createLogger, maskEmail } from '../api-utils';
import type { OrderItem } from './create-order-emails';

const log = createLogger('create-order');

const MAX_STOCK_RETRIES = 3;

interface MerchStockUpdateParams {
  items: OrderItem[];
  orderRefId: string;
  orderNumber: string;
  now: string;
  idToken?: string;
  env: Record<string, unknown>;
}

/**
 * Update stock for merch items after order creation.
 * Uses optimistic concurrency (conditional update) to prevent overselling.
 * Mutates items in-place to attach sellerEmail/supplierId (matches original behavior).
 */
export async function updateMerchStockAfterOrder({ items, orderRefId, orderNumber, now, idToken, env }: MerchStockUpdateParams): Promise<void> {
  for (const item of items) {
    if (item.type === 'merch' && item.productId) {
      try {
        log.info('[create-order] Updating stock for merch item:', item.name, 'qty:', item.quantity);

        let stockUpdated = false;
        let previousStock = 0;
        let newStock = 0;
        let variantKey = '';
        let productData: Record<string, unknown> | null = null;

        for (let attempt = 0; attempt < MAX_STOCK_RETRIES; attempt++) {
          // Clear cache on retry to get fresh data
          if (attempt > 0) {
            clearCache(`doc:merch:${item.productId}`);
            log.info(`[create-order] Stock update retry ${attempt + 1}/${MAX_STOCK_RETRIES} for ${item.name}`);
          }

          productData = await getDocument('merch', item.productId);
          if (!productData) break;

          // Deep clone variantStock to avoid mutating cached data
          const variantStock: Record<string, Record<string, unknown>> = {};
          for (const [k, v] of Object.entries((productData.variantStock as Record<string, Record<string, unknown>>) || {})) {
            variantStock[k] = { ...v };
          }

          // Build variant key from size and color
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          variantKey = size + '_' + color;

          // Check if variant exists, otherwise try fallback matching
          if (!variantStock[variantKey]) {
            const keys = Object.keys(variantStock);
            if (keys.length === 1) {
              variantKey = keys[0];
            } else if (keys.length > 1) {
              const sizeMatch = keys.find(k => k.startsWith(size + '_'));
              const colorMatch = keys.find(k => k.endsWith('_' + color));
              variantKey = sizeMatch || colorMatch || keys[0];
            }
          }

          const variant = variantStock[variantKey];
          if (!variant) {
            log.info('[create-order] ⚠️ Variant not found:', variantKey, 'for product:', item.productId);
            break;
          }

          previousStock = variant.stock || 0;
          newStock = Math.max(0, previousStock - item.quantity);

          if (previousStock < item.quantity) {
            log.info('[create-order] ⚠️ Insufficient stock:', item.name, variantKey,
              '- Ordered:', item.quantity, '- Available:', previousStock);
            // Allow order but flag it - stock already went negative, alert admin
            // Order was already created above, so we proceed but log the oversell
          }

          variant.stock = newStock;
          variant.sold = (variant.sold || 0) + item.quantity;
          variantStock[variantKey] = variant;

          let totalStock = 0;
          let totalSold = 0;
          Object.values(variantStock).forEach((v: Record<string, unknown>) => {
            totalStock += (v.stock as number) || 0;
            totalSold += (v.sold as number) || 0;
          });

          try {
            // Conditional update - fails if document was modified since we read it
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
              // Fallback to non-conditional update if no updateTime available
              await updateDocument('merch', item.productId, {
                variantStock: variantStock,
                totalStock: totalStock,
                soldStock: totalSold,
                isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                isOutOfStock: totalStock === 0,
                updatedAt: now
              });
            }
            stockUpdated = true;
            log.info('[create-order] ✓ Stock updated:', item.name, variantKey, previousStock, '->', newStock);
            break; // Success - exit retry loop
          } catch (conflictErr: unknown) {
            const conflictMessage = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
            if (conflictMessage?.includes('CONFLICT') && attempt < MAX_STOCK_RETRIES - 1) {
              log.info(`[create-order] Stock conflict for ${item.name}, retrying...`);
              continue;
            }
            throw conflictErr;
          }
        }

        // Only record stock movement and do post-update work if stock was actually updated
        if (stockUpdated && productData) {
          // Record stock movement
          await addDocument('merch-stock-movements', {
            productId: item.productId,
            productName: item.name,
            sku: productData.sku,
            variantKey: variantKey,
            variantSku: productData.variantStock?.[variantKey]?.sku,
            type: 'sell',
            quantity: item.quantity,
            stockDelta: -item.quantity,
            previousStock: previousStock,
            newStock: newStock,
            orderId: orderRefId,
            orderNumber: orderNumber,
            notes: 'Order ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);

          // Sync to D1 so public merch page shows updated stock
          const db = env?.DB;
          if (db) {
            try {
              clearCache(`doc:merch:${item.productId}`);
              const updatedProduct = await getDocument('merch', item.productId);
              if (updatedProduct) {
                await d1UpsertMerch(db as D1Database, item.productId, updatedProduct);
                log.info('[create-order] ✓ D1 synced for:', item.name);
              }
            } catch (d1Error: unknown) {
              log.error('[create-order] D1 sync failed (non-critical):', d1Error);
            }
          }

          // Update supplier stats atomically and get seller email for notifications
          if (productData.supplierId) {
            try {
              const supplierRevenue = (productData.retailPrice || item.price) * item.quantity * ((productData.supplierCut || 0) / 100);

              // Use atomic increment for supplier counters to prevent race conditions
              await atomicIncrement('merch-suppliers', productData.supplierId, {
                totalStock: -item.quantity,
                totalSold: item.quantity,
                totalRevenue: supplierRevenue,
              });
              await updateDocument('merch-suppliers', productData.supplierId, { updatedAt: now });
              log.info('[create-order] ✓ Supplier stats updated (atomic)');

              // Fetch supplier data for email (read-only, no race concern)
              const supplierData = await getDocument('merch-suppliers', productData.supplierId);
              if (supplierData?.email) {
                item.sellerEmail = supplierData.email;
                item.supplierId = productData.supplierId;
                log.info('[create-order] ✓ Attached seller email from merch-suppliers:', maskEmail(supplierData.email));
              }

              // If no email yet, try users collection
              if (!item.sellerEmail) {
                const userData = await getDocument('users', productData.supplierId);
                if (userData?.email) {
                  item.sellerEmail = userData.email;
                  item.supplierId = productData.supplierId;
                  log.info('[create-order] ✓ Attached seller email from users:', maskEmail(userData.email));
                }
              }

              // If still no email, try artists collection
              if (!item.sellerEmail) {
                const artistData = await getDocument('artists', productData.supplierId);
                if (artistData?.email) {
                  item.sellerEmail = artistData.email;
                  item.supplierId = productData.supplierId;
                  log.info('[create-order] ✓ Attached seller email from artists:', maskEmail(artistData.email));
                }
              }
            } catch (supplierErr: unknown) {
              log.info('[create-order] Could not update supplier stats:', supplierErr);
            }
          }

          // Also attach supplierId/sellerId to item for sales ledger
          if (productData.supplierId && !item.supplierId) {
            item.supplierId = productData.supplierId;
            item.sellerId = productData.supplierId;
          }
          if (productData.sellerId && !item.sellerId) {
            item.sellerId = productData.sellerId;
          }
        } else if (!productData) {
          log.info('[create-order] ⚠️ Product not found for stock update:', item.productId);
        }
      } catch (stockErr: unknown) {
        // Log but don't fail the order
        log.error('[create-order] Stock update error:', stockErr);
      }
    }
  }
}
