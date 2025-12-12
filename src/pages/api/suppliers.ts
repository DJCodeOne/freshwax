// src/pages/api/suppliers.ts
// Manage merch suppliers/consignment partners

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Initialize Firebase
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

// GET - List all suppliers or get specific supplier
export const GET: APIRoute = async ({ url }) => {
  try {
    const params = url.searchParams;
    const supplierId = params.get('id');
    const includeProducts = params.get('products') === 'true';
    const accessCode = params.get('code'); // For supplier portal access
    
    if (supplierId) {
      // Get specific supplier
      const doc = await db.collection('merch-suppliers').doc(supplierId).get();
      
      if (!doc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Supplier not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const supplier = { id: doc.id, ...doc.data() };
      
      // Get their products if requested
      let products: any[] = [];
      if (includeProducts) {
        const productsSnapshot = await db.collection('merch')
          .where('supplierId', '==', supplierId)
          .get();
        
        productsSnapshot.forEach(doc => {
          const data = doc.data();
          products.push({
            id: doc.id,
            name: data.name,
            sku: data.sku,
            productType: data.productTypeName,
            retailPrice: data.retailPrice,
            totalStock: data.totalStock,
            soldStock: data.soldStock || 0,
            isLowStock: data.isLowStock,
            isOutOfStock: data.isOutOfStock,
            primaryImage: data.primaryImage,
            status: data.status
          });
        });
      }
      
      return new Response(JSON.stringify({
        success: true,
        supplier: supplier,
        products: products
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=60'
        }
      });
    }
    
    // Supplier portal access via code
    if (accessCode) {
      const snapshot = await db.collection('merch-suppliers')
        .where('accessCode', '==', accessCode)
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid access code'
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      
      const supplierDoc = snapshot.docs[0];
      const supplier: any = { id: supplierDoc.id, ...supplierDoc.data() };
      
      // Get their products
      const productsSnapshot = await db.collection('merch')
        .where('supplierId', '==', supplierDoc.id)
        .get();
      
      const products: any[] = [];
      productsSnapshot.forEach(doc => {
        const data = doc.data();
        products.push({
          id: doc.id,
          name: data.name,
          sku: data.sku,
          productType: data.productTypeName,
          retailPrice: data.retailPrice,
          costPrice: data.costPrice,
          supplierCut: data.supplierCut,
          totalStock: data.totalStock,
          soldStock: data.soldStock || 0,
          isLowStock: data.isLowStock,
          isOutOfStock: data.isOutOfStock,
          lowStockThreshold: data.lowStockThreshold,
          primaryImage: data.primaryImage,
          variantStock: data.variantStock
        });
      });
      
      // Calculate earnings
      let totalEarnings = 0;
      products.forEach(p => {
        totalEarnings += (p.retailPrice * p.soldStock * (p.supplierCut / 100));
      });
      
      return new Response(JSON.stringify({
        success: true,
        supplier: {
          id: supplier.id,
          name: supplier.name,
          email: supplier.email,
          type: supplier.type
        },
        products: products,
        stats: {
          totalProducts: products.length,
          totalStock: products.reduce((sum, p) => sum + p.totalStock, 0),
          totalSold: products.reduce((sum, p) => sum + p.soldStock, 0),
          lowStockItems: products.filter(p => p.isLowStock).length,
          outOfStockItems: products.filter(p => p.isOutOfStock).length,
          totalEarnings: totalEarnings
        }
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=60'
        }
      });
    }
    
    // List all suppliers (admin only)
    const snapshot = await db.collection('merch-suppliers').get();
    
    const suppliers: any[] = [];
    snapshot.forEach(doc => {
      suppliers.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    log.info('[suppliers] Listed', suppliers.length, 'suppliers');
    
    return new Response(JSON.stringify({
      success: true,
      count: suppliers.length,
      suppliers: suppliers
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60'
      }
    });
    
  } catch (error) {
    log.error('[suppliers] GET Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch suppliers',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Create new supplier
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    
    const {
      name,
      email,
      phone,
      type, // 'label', 'soundsystem', 'dj', 'crew', 'other'
      code, // Short code for SKUs e.g., 'RUN' for Runnin' Records
      defaultCut, // Default percentage they get per sale
      contactName,
      address,
      notes
    } = body;
    
    if (!name || !type || !code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Name, type, and code are required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Generate supplier ID and access code
    const timestamp = Date.now();
    const supplierId = 'supplier_' + code.toLowerCase() + '_' + timestamp;
    const accessCode = code.toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const supplierData = {
      id: supplierId,
      name: name,
      email: email || null,
      phone: phone || null,
      type: type,
      code: code.toUpperCase(),
      defaultCut: defaultCut || 50, // Default 50/50 split
      contactName: contactName || null,
      address: address || null,
      notes: notes || null,
      accessCode: accessCode, // For supplier portal
      
      // Stats
      totalProducts: 0,
      totalStock: 0,
      totalSold: 0,
      totalRevenue: 0,
      totalDamaged: 0,
      
      // Status
      active: true,
      
      // Timestamps
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await db.collection('merch-suppliers').doc(supplierId).set(supplierData);
    
    log.info('[suppliers] Created supplier:', name, '(' + supplierId + ')');
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Supplier created successfully',
      supplier: supplierData,
      accessCode: accessCode // Return this once - they'll need it to access their portal
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    log.error('[suppliers] POST Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to create supplier',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// PUT - Update supplier
export const PUT: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { supplierId, ...updates } = body;
    
    if (!supplierId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Prevent updating certain fields
    delete updates.id;
    delete updates.accessCode;
    delete updates.createdAt;
    delete updates.totalProducts;
    delete updates.totalStock;
    delete updates.totalSold;
    delete updates.totalRevenue;
    
    updates.updatedAt = new Date().toISOString();
    
    await db.collection('merch-suppliers').doc(supplierId).update(updates);
    
    log.info('[suppliers] Updated supplier:', supplierId);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Supplier updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    log.error('[suppliers] PUT Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update supplier',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE - Deactivate or permanently delete supplier
export const DELETE: APIRoute = async ({ request, url }) => {
  try {
    const { supplierId, hardDelete } = await request.json();
    
    if (!supplierId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    if (hardDelete) {
      // Permanently delete the supplier
      await db.collection('merch-suppliers').doc(supplierId).delete();
      
      log.info('[suppliers] Permanently deleted supplier:', supplierId);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Supplier permanently deleted'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      // Soft delete - just deactivate
      await db.collection('merch-suppliers').doc(supplierId).update({
        active: false,
        deactivatedAt: new Date().toISOString()
      });
      
      log.info('[suppliers] Deactivated supplier:', supplierId);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Supplier deactivated successfully'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
  } catch (error) {
    log.error('[suppliers] DELETE Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete supplier',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};