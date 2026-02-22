// src/pages/api/update-stock.ts
// Handles all stock operations: receive, adjust, transfer, reserve, sell

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection, clearAllMerchCache, clearCache } from '../../lib/firebase-rest';
import { saUpdateDocument, saSetDocument, getServiceAccountKeyWithProject } from '../../lib/firebase-service-account';
import { requireAdminAuth } from '../../lib/admin';
import { d1UpsertMerch } from '../../lib/d1-catalog';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const updateStockSchema = z.object({
  productId: z.string().min(1),
  variantKey: z.string().optional().default('default'),
  operation: z.enum(['receive', 'adjust', 'sell', 'return', 'reserve', 'unreserve', 'damaged', 'transfer', 'set']),
  quantity: z.number(),
  notes: z.string().optional().default(''),
  orderId: z.string().optional(),
  userId: z.string().optional().default('admin'),
});

const logger = createLogger('update-stock');

export const prerender = false;

type StockOperation = 'receive' | 'adjust' | 'sell' | 'return' | 'reserve' | 'unreserve' | 'damaged' | 'transfer' | 'set';

interface StockUpdate {
  productId: string;
  variantKey?: string;
  operation: StockOperation;
  quantity: number;
  notes?: string;
  orderId?: string;
  userId?: string;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = locals.runtime.env;
  // Get service account credentials for writes
  const { key: serviceAccountKey, projectId } = getServiceAccountKeyWithProject(env);

  try {
    const body = await request.json();

    const parsed = updateStockSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const {
      productId,
      variantKey,
      operation,
      quantity,
      notes,
      orderId,
      userId
    } = parsed.data;

    logger.info('[update-stock]', operation.toUpperCase(), quantity, 'units for', productId);

    if (quantity < 0 && !['adjust', 'damaged', 'set'].includes(operation)) {
      return ApiErrors.badRequest('Quantity must be positive for this operation');
    }

    const product = await getDocument('merch', productId);

    if (!product) {
      return ApiErrors.notFound('Product not found');
    }

    const variantStock = product.variantStock || {};

    if (!variantStock[variantKey]) {
      return ApiErrors.notFound('Variant not found: ');
    }

    // Handle both old (number) and new (object) formats
    let variant = variantStock[variantKey];
    if (typeof variant === 'number') {
      // Convert old format to new format
      variant = {
        stock: variant,
        reserved: 0,
        sold: 0,
        size: null,
        color: null,
        colorHex: null
      };
      variantStock[variantKey] = variant;
    }
    const previousStock = variant.stock || 0;
    let newStock = previousStock;
    let stockDelta = 0;

    switch (operation) {
      case 'receive':
        newStock = previousStock + quantity;
        stockDelta = quantity;
        break;

      case 'adjust':
        newStock = previousStock + quantity;
        stockDelta = quantity;
        break;

      case 'sell':
        if (previousStock < quantity) {
          return ApiErrors.badRequest('Insufficient stock. Available: ');
        }
        newStock = previousStock - quantity;
        stockDelta = -quantity;
        variant.sold = (variant.sold || 0) + quantity;
        break;

      case 'return':
        newStock = previousStock + quantity;
        stockDelta = quantity;
        variant.sold = Math.max(0, (variant.sold || 0) - quantity);
        break;

      case 'reserve':
        if (previousStock < quantity) {
          return ApiErrors.badRequest('Insufficient stock to reserve. Available: ');
        }
        newStock = previousStock - quantity;
        stockDelta = -quantity;
        variant.reserved = (variant.reserved || 0) + quantity;
        break;

      case 'unreserve':
        newStock = previousStock + quantity;
        stockDelta = quantity;
        variant.reserved = Math.max(0, (variant.reserved || 0) - quantity);
        break;

      case 'damaged':
        newStock = Math.max(0, previousStock - Math.abs(quantity));
        stockDelta = -Math.abs(quantity);
        break;

      case 'set':
        // Set stock to absolute value (for stock takes)
        newStock = Math.max(0, quantity);
        stockDelta = newStock - previousStock;
        break;

      default:
        return ApiErrors.badRequest('Unknown operation: ');
    }

    newStock = Math.max(0, newStock);

    variant.stock = newStock;
    variantStock[variantKey] = variant;

    let totalStock = 0;
    let totalReserved = 0;
    let totalSold = 0;

    Object.values(variantStock).forEach((v: unknown) => {
      // Handle both old (number) and new (object) formats
      if (typeof v === 'number') {
        totalStock += v;
      } else {
        const vObj = v as Record<string, unknown>;
        totalStock += (vObj.stock as number) || 0;
        totalReserved += (vObj.reserved as number) || 0;
        totalSold += (vObj.sold as number) || 0;
      }
    });

    const updateData = {
      variantStock: variantStock,
      totalStock: totalStock,
      reservedStock: totalReserved,
      soldStock: totalSold,
      isLowStock: totalStock <= (product.lowStockThreshold || 5) && totalStock > 0,
      isOutOfStock: totalStock === 0,
      updatedAt: new Date().toISOString()
    };

    await saUpdateDocument(serviceAccountKey, projectId, 'merch', productId, updateData);

    const movementId = 'movement_' + Date.now();
    await saSetDocument(serviceAccountKey, projectId, 'merch-stock-movements', movementId, {
      id: movementId,
      productId: productId,
      productName: product.name,
      sku: product.sku,
      variantKey: variantKey,
      variantSku: variant.sku,
      type: operation,
      quantity: quantity,
      stockDelta: stockDelta,
      previousStock: previousStock,
      newStock: newStock,
      orderId: orderId || null,
      notes: notes,
      supplierId: product.supplierId || null,
      supplierName: product.supplierName || null,
      createdAt: new Date().toISOString(),
      createdBy: userId
    });

    if (product.supplierId && ['receive', 'sell', 'return', 'damaged'].includes(operation)) {
      try {
        const supplierData = await getDocument('merch-suppliers', product.supplierId);
        if (supplierData) {
          const supplierUpdate: Record<string, unknown> = {
            updatedAt: new Date().toISOString()
          };

          if (operation === 'receive') {
            supplierUpdate.totalStock = (supplierData.totalStock || 0) + quantity;
          } else if (operation === 'sell') {
            supplierUpdate.totalStock = (supplierData.totalStock || 0) - quantity;
            supplierUpdate.totalSold = (supplierData.totalSold || 0) + quantity;
            const supplierRevenue = (product.retailPrice * quantity * (product.supplierCut / 100));
            supplierUpdate.totalRevenue = (supplierData.totalRevenue || 0) + supplierRevenue;
          } else if (operation === 'return') {
            supplierUpdate.totalStock = (supplierData.totalStock || 0) + quantity;
            supplierUpdate.totalSold = (supplierData.totalSold || 0) - quantity;
          } else if (operation === 'damaged') {
            supplierUpdate.totalStock = (supplierData.totalStock || 0) - Math.abs(quantity);
            supplierUpdate.totalDamaged = (supplierData.totalDamaged || 0) + Math.abs(quantity);
          }

          await saUpdateDocument(serviceAccountKey, projectId, 'merch-suppliers', product.supplierId, supplierUpdate);
        }
      } catch (e: unknown) {
        logger.info('Note: Could not update supplier stats');
      }
    }

    logger.info('[update-stock]', operation + ':', previousStock, '->', newStock);

    // Dual-write to D1 so stock changes reflect on merch page
    const db = env?.DB;
    if (db) {
      try {
        // Clear document cache first to get fresh data
        clearCache(`doc:merch:${productId}`);
        const updatedProduct = await getDocument('merch', productId);
        if (updatedProduct) {
          await d1UpsertMerch(db, productId, updatedProduct);
          logger.info('[update-stock] Also updated in D1');
        }
      } catch (d1Error: unknown) {
        logger.error('[update-stock] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Clear merch caches so stock changes reflect immediately
    clearAllMerchCache();

    return successResponse({ operation: operation,
      productId: productId,
      variantKey: variantKey,
      previousStock: previousStock,
      newStock: newStock,
      stockDelta: stockDelta,
      totalProductStock: totalStock,
      isLowStock: updateData.isLowStock,
      isOutOfStock: updateData.isOutOfStock });

  } catch (error: unknown) {
    logger.error('[update-stock] Error:', error);

    return ApiErrors.serverError('Failed to update stock');
  }
};

export const GET: APIRoute = async ({ url, request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  try {
    const params = url.searchParams;
    const productId = params.get('productId');
    const lowStockOnly = params.get('lowStock') === 'true';
    const supplierId = params.get('supplier');

    if (productId) {
      const data = await getDocument('merch', productId);

      if (!data) {
        return ApiErrors.notFound('Product not found');
      }

      return successResponse({ productId: productId,
        name: data.name,
        sku: data.sku,
        totalStock: data.totalStock,
        reservedStock: data.reservedStock,
        soldStock: data.soldStock,
        isLowStock: data.isLowStock,
        isOutOfStock: data.isOutOfStock,
        lowStockThreshold: data.lowStockThreshold,
        variantStock: data.variantStock });
    }

    // Fetch products and suppliers in parallel for name resolution
    const [products, merchSuppliers, users] = await Promise.all([
      queryCollection('merch', {
        filters: lowStockOnly ? [{ field: 'isLowStock', op: 'EQUAL', value: true }] : undefined
      }),
      queryCollection('merch-suppliers', { limit: 100 }),
      queryCollection('users', { limit: 500 })
    ]);

    // Build supplier lookup maps by ID and email
    const supplierById = new Map<string, string>();
    const supplierByEmail = new Map<string, string>();

    // Add merch-suppliers
    merchSuppliers.forEach((s: Record<string, unknown>) => {
      if (s.id) supplierById.set(s.id, s.name || 'Unknown');
      if (s.email) supplierByEmail.set(s.email.toLowerCase(), s.name || 'Unknown');
    });

    // Add users with merchSupplier/merchSeller role
    users.forEach((u: Record<string, unknown>) => {
      const roles = (u.roles || {}) as Record<string, unknown>;
      if (roles.merchSupplier === true || roles.merchSeller === true || u.isMerchSupplier === true) {
        const partnerInfo = u.partnerInfo as Record<string, unknown> | undefined;
        const name = partnerInfo?.storeName || partnerInfo?.displayName || u.displayName || u.artistName || 'Unknown';
        if (u.id) supplierById.set(u.id, name);
        if (u.email) supplierByEmail.set(u.email.toLowerCase(), name);
      }
    });

    // Helper to resolve supplier name
    // Note: categoryName is used as the supplier/brand name in this system
    function resolveSupplierName(data: Record<string, unknown>): string {
      // categoryName is the primary supplier identifier
      if (data.categoryName && data.categoryName !== data.category) {
        return data.categoryName;
      }

      // Try explicit supplierName
      if (data.supplierName) return data.supplierName;
      if (data.supplier) return data.supplier;

      // Try lookup by supplierId
      if (data.supplierId && supplierById.has(data.supplierId)) {
        return supplierById.get(data.supplierId)!;
      }

      // Try lookup by supplierEmail
      if (data.supplierEmail && supplierByEmail.has(data.supplierEmail.toLowerCase())) {
        return supplierByEmail.get(data.supplierEmail.toLowerCase())!;
      }

      // Try lookup by createdBy (user ID who uploaded)
      if (data.createdBy && supplierById.has(data.createdBy)) {
        return supplierById.get(data.createdBy)!;
      }

      return 'Fresh Wax';
    }

    const stockReport: Record<string, unknown>[] = [];
    products.forEach((data: Record<string, unknown>) => {
      const resolvedSupplier = resolveSupplierName(data);
      stockReport.push({
        productId: data.id,
        name: data.name,
        sku: data.sku,
        productType: data.productType,
        category: data.categoryName || data.category,
        productCategory: data.category,
        supplierId: data.supplierId,
        supplierName: resolvedSupplier,
        supplier: resolvedSupplier,
        totalStock: data.totalStock,
        reservedStock: data.reservedStock || 0,
        soldStock: data.soldStock || 0,
        isLowStock: data.isLowStock,
        isOutOfStock: data.isOutOfStock,
        lowStockThreshold: data.lowStockThreshold,
        variantStock: data.variantStock,
        images: data.images || [],
        primaryImage: data.primaryImage || data.images?.[0]?.url || null
      });
    });

    stockReport.sort((a, b) => a.totalStock - b.totalStock);

    return successResponse({ count: stockReport.length,
      lowStockCount: stockReport.filter(p => p.isLowStock).length,
      outOfStockCount: stockReport.filter(p => p.isOutOfStock).length,
      products: stockReport });

  } catch (error: unknown) {
    logger.error('[get-stock] Error:', error);

    return ApiErrors.serverError('Failed to fetch stock');
  }
};
