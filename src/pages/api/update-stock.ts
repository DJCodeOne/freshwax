// src/pages/api/update-stock.ts
// Handles all stock operations: receive, adjust, transfer, reserve, sell

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv, clearAllMerchCache, clearCache } from '../../lib/firebase-rest';
import { saUpdateDocument, saSetDocument } from '../../lib/firebase-service-account';
import { requireAdminAuth } from '../../lib/admin';
import { d1UpsertMerch } from '../../lib/d1-catalog';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Get service account credentials
function getServiceAccountKey(env: any): { key: string; projectId: string } {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY ||
                          import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountKey) {
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (clientEmail && privateKey) {
      serviceAccountKey = JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        private_key_id: 'auto',
        private_key: privateKey.replace(/\\n/g, '\n'),
        client_email: clientEmail,
        client_id: '',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
      });
    }
  }

  if (!serviceAccountKey) {
    throw new Error('Firebase service account not configured');
  }

  return { key: serviceAccountKey, projectId };
}

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
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebase(locals);

  // Get service account credentials for writes
  const { key: serviceAccountKey, projectId } = getServiceAccountKey(env);

  try {
    const body = await request.json() as StockUpdate;

    const {
      productId,
      variantKey = 'default',
      operation,
      quantity,
      notes = '',
      orderId,
      userId = 'admin'
    } = body;

    log.info('[update-stock]', operation.toUpperCase(), quantity, 'units for', productId);

    if (!productId || !operation || quantity === undefined) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: productId, operation, quantity'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (quantity < 0 && !['adjust', 'damaged', 'set'].includes(operation)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Quantity must be positive for this operation'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const product = await getDocument('merch', productId);

    if (!product) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const variantStock = product.variantStock || {};

    if (!variantStock[variantKey]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Variant not found: ' + variantKey
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
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
          return new Response(JSON.stringify({
            success: false,
            error: 'Insufficient stock. Available: ' + previousStock
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
          return new Response(JSON.stringify({
            success: false,
            error: 'Insufficient stock to reserve. Available: ' + previousStock
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Unknown operation: ' + operation
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    newStock = Math.max(0, newStock);

    variant.stock = newStock;
    variantStock[variantKey] = variant;

    let totalStock = 0;
    let totalReserved = 0;
    let totalSold = 0;

    Object.values(variantStock).forEach((v: any) => {
      // Handle both old (number) and new (object) formats
      if (typeof v === 'number') {
        totalStock += v;
      } else {
        totalStock += v.stock || 0;
        totalReserved += v.reserved || 0;
        totalSold += v.sold || 0;
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
          const supplierUpdate: any = {
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
      } catch (e) {
        log.info('Note: Could not update supplier stats');
      }
    }

    log.info('[update-stock]', operation + ':', previousStock, '->', newStock);

    // Dual-write to D1 so stock changes reflect on merch page
    const db = env?.DB;
    if (db) {
      try {
        // Clear document cache first to get fresh data
        clearCache(`doc:merch:${productId}`);
        const updatedProduct = await getDocument('merch', productId);
        if (updatedProduct) {
          await d1UpsertMerch(db, productId, updatedProduct);
          log.info('[update-stock] Also updated in D1');
        }
      } catch (d1Error) {
        log.error('[update-stock] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Clear merch caches so stock changes reflect immediately
    clearAllMerchCache();

    return new Response(JSON.stringify({
      success: true,
      operation: operation,
      productId: productId,
      variantKey: variantKey,
      previousStock: previousStock,
      newStock: newStock,
      stockDelta: stockDelta,
      totalProductStock: totalStock,
      isLowStock: updateData.isLowStock,
      isOutOfStock: updateData.isOutOfStock
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[update-stock] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update stock',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const GET: APIRoute = async ({ url, request, locals }) => {
  // Admin authentication required
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const params = url.searchParams;
    const productId = params.get('productId');
    const lowStockOnly = params.get('lowStock') === 'true';
    const supplierId = params.get('supplier');

    if (productId) {
      const data = await getDocument('merch', productId);

      if (!data) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Product not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        success: true,
        productId: productId,
        name: data.name,
        sku: data.sku,
        totalStock: data.totalStock,
        reservedStock: data.reservedStock,
        soldStock: data.soldStock,
        isLowStock: data.isLowStock,
        isOutOfStock: data.isOutOfStock,
        lowStockThreshold: data.lowStockThreshold,
        variantStock: data.variantStock
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build filters for query
    const filters: Array<{field: string, op: any, value: any}> = [];
    if (lowStockOnly) {
      filters.push({ field: 'isLowStock', op: 'EQUAL', value: true });
    }
    if (supplierId) {
      filters.push({ field: 'supplierId', op: 'EQUAL', value: supplierId });
    }

    const products = await queryCollection('merch', {
      filters: filters.length > 0 ? filters : undefined
    });

    const stockReport: any[] = [];
    products.forEach(data => {
      stockReport.push({
        productId: data.id,
        name: data.name,
        sku: data.sku,
        productType: data.productType,
        category: data.categoryName,
        supplierId: data.supplierId,
        supplierName: data.supplierName,
        supplier: data.supplierName || 'Fresh Wax',
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

    return new Response(JSON.stringify({
      success: true,
      count: stockReport.length,
      lowStockCount: stockReport.filter(p => p.isLowStock).length,
      outOfStockCount: stockReport.filter(p => p.isOutOfStock).length,
      products: stockReport
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[get-stock] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch stock',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
