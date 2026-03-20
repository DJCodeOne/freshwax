// src/lib/order/merch-processing.ts
// Merch stock updates with optimistic concurrency

import { getDocument, updateDocument, addDocument, clearCache, updateDocumentConditional, atomicIncrement } from '../firebase-rest';
import { d1UpsertMerch } from '../d1-catalog';
import { log } from './types';
import type { CartItem, VariantStockEntry } from './types';

// Update stock for merch items (with optimistic concurrency)
export async function updateMerchStock(items: CartItem[], orderNumber: string, orderId: string, idToken?: string, env?: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const MAX_RETRIES = 3;

  for (const item of items) {
    if (item.type === 'merch' && item.productId) {
      let stockUpdated = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          log.info('[order-utils] Updating stock for merch item:', item.name, 'qty:', item.quantity, 'attempt:', attempt + 1);

          const productData = await getDocument('merch', item.productId);

          if (!productData) break;

          const variantStock = productData.variantStock || {};

          // Build variant key from size and color
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;

          // Exact match only - no heuristic guessing to avoid updating wrong variant
          if (!variantStock[variantKey]) {
            log.error('[order-utils] Variant key not found:', variantKey, 'for item:', item.name, 'available keys:', Object.keys(variantStock));
            break;
          }

          const variant = variantStock[variantKey];
          if (!variant) break;

          const previousStock = variant.stock || 0;
          const newStock = Math.max(0, previousStock - item.quantity);

          variant.stock = newStock;
          variant.sold = (variant.sold || 0) + item.quantity;
          variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
          variantStock[variantKey] = variant;

          // Calculate totals
          let totalStock = 0;
          let totalSold = 0;
          let totalReserved = 0;
          Object.values(variantStock).forEach((v: unknown) => {
            const variant = v as VariantStockEntry;
            totalStock += variant.stock || 0;
            totalSold += variant.sold || 0;
            totalReserved += (typeof v === 'object' ? variant.reserved || 0 : 0);
          });

          const updateData = {
            variantStock: variantStock,
            totalStock: totalStock,
            soldStock: totalSold,
            reservedStock: totalReserved,
            isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
            isOutOfStock: totalStock === 0,
            updatedAt: now
          };

          try {
            // Conditional update - fails if document was modified since we read it
            if (productData._updateTime) {
              await updateDocumentConditional('merch', item.productId, updateData, productData._updateTime);
            } else {
              await updateDocument('merch', item.productId, updateData);
            }
            stockUpdated = true;
            log.info('[order-utils] ✓ Stock updated:', item.name, variantKey, previousStock, '->', newStock);
            break; // Success - exit retry loop
          } catch (conflictErr: unknown) {
            if (conflictErr instanceof Error && conflictErr.message.includes('CONFLICT') && attempt < MAX_RETRIES - 1) {
              log.info('[order-utils] Stock conflict for', item.name, '- retrying...');
              continue;
            }
            throw conflictErr;
          }
        } catch (stockErr: unknown) {
          if (attempt === MAX_RETRIES - 1) {
            log.error('[order-utils] Stock update error after', MAX_RETRIES, 'attempts:', stockErr);
          }
        }
      }

      if (stockUpdated) {
        // Record stock movement
        try {
          const productData = await getDocument('merch', item.productId);
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;
          const variant = productData?.variantStock?.[variantKey];

          await addDocument('merch-stock-movements', {
            productId: item.productId,
            productName: item.name,
            sku: productData?.sku,
            variantKey: variantKey,
            variantSku: variant?.sku,
            type: 'sell',
            quantity: item.quantity,
            stockDelta: -item.quantity,
            previousStock: (variant?.stock || 0) + item.quantity,
            newStock: variant?.stock || 0,
            orderId: orderId,
            orderNumber: orderNumber,
            notes: 'Order ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);
        } catch (movementErr: unknown) {
          log.error('[order-utils] Stock movement log error:', movementErr);
        }

        // Sync to D1
        const db = env?.DB;
        if (db) {
          try {
            clearCache(`doc:merch:${item.productId}`);
            const updatedProduct = await getDocument('merch', item.productId);
            if (updatedProduct) {
              await d1UpsertMerch(db, item.productId, updatedProduct);
              log.info('[order-utils] ✓ D1 synced for:', item.name);
            }
          } catch (d1Error: unknown) {
            log.error('[order-utils] D1 sync failed (non-critical):', d1Error);
          }
        }

        // Update supplier stats atomically
        try {
          const productData = await getDocument('merch', item.productId);
          if (productData?.supplierId) {
            const supplierRevenue = (productData.retailPrice || item.price) * item.quantity * ((productData.supplierCut || 0) / 100);
            await atomicIncrement('merch-suppliers', productData.supplierId, {
              totalStock: -item.quantity,
              totalSold: item.quantity,
              totalRevenue: supplierRevenue
            });
          }
        } catch (supplierErr: unknown) {
          log.info('[order-utils] Could not update supplier stats');
        }
      }
    }
  }
}
