// src/pages/api/update-stock.ts
// Handles all stock operations: receive, adjust, transfer, reserve, sell

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = getFirestore();

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

export const POST: APIRoute = async ({ request }) => {
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
    
    const productRef = db.collection('merch').doc(productId);
    const productDoc = await productRef.get();
    
    if (!productDoc.exists) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    const product = productDoc.data()!;
    const variantStock = product.variantStock || {};
    
    if (!variantStock[variantKey]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Variant not found: ' + variantKey
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    const variant = variantStock[variantKey];
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
      totalStock += v.stock || 0;
      totalReserved += v.reserved || 0;
      totalSold += v.sold || 0;
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
    
    await productRef.update(updateData);
    
    const movementId = 'movement_' + Date.now();
    await db.collection('merch-stock-movements').doc(movementId).set({
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
        const supplierUpdate: any = {
          updatedAt: new Date().toISOString()
        };
        
        if (operation === 'receive') {
          supplierUpdate.totalStock = FieldValue.increment(quantity);
        } else if (operation === 'sell') {
          supplierUpdate.totalStock = FieldValue.increment(-quantity);
          supplierUpdate.totalSold = FieldValue.increment(quantity);
          const supplierRevenue = (product.retailPrice * quantity * (product.supplierCut / 100));
          supplierUpdate.totalRevenue = FieldValue.increment(supplierRevenue);
        } else if (operation === 'return') {
          supplierUpdate.totalStock = FieldValue.increment(quantity);
          supplierUpdate.totalSold = FieldValue.increment(-quantity);
        } else if (operation === 'damaged') {
          supplierUpdate.totalStock = FieldValue.increment(-Math.abs(quantity));
          supplierUpdate.totalDamaged = FieldValue.increment(Math.abs(quantity));
        }
        
        await db.collection('merch-suppliers').doc(product.supplierId).update(supplierUpdate);
      } catch (e) {
        log.info('Note: Could not update supplier stats');
      }
    }
    
    log.info('[update-stock]', operation + ':', previousStock, '->', newStock);
    
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

export const GET: APIRoute = async ({ url }) => {
  try {
    const params = url.searchParams;
    const productId = params.get('productId');
    const lowStockOnly = params.get('lowStock') === 'true';
    const supplierId = params.get('supplier');
    
    if (productId) {
      const doc = await db.collection('merch').doc(productId).get();
      
      if (!doc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Product not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const data = doc.data()!;
      
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
    
    let query: FirebaseFirestore.Query = db.collection('merch');
    
    if (lowStockOnly) {
      query = query.where('isLowStock', '==', true);
    }
    
    if (supplierId) {
      query = query.where('supplierId', '==', supplierId);
    }
    
    const snapshot = await query.get();
    
    const stockReport: any[] = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      stockReport.push({
        productId: doc.id,
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