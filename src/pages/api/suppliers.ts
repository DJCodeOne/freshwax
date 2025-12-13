// src/pages/api/suppliers.ts
// Manage merch suppliers/consignment partners - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument, updateDocument, deleteDocument } from '../../lib/firebase-rest';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// GET - List all suppliers or get specific supplier
export const GET: APIRoute = async ({ url }) => {
  try {
    const params = url.searchParams;
    const supplierId = params.get('id');
    const includeProducts = params.get('products') === 'true';
    const accessCode = params.get('code');

    if (supplierId) {
      // Get specific supplier
      const supplier = await getDocument('merch-suppliers', supplierId);

      if (!supplier) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Supplier not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      // Get their products if requested
      let products: any[] = [];
      if (includeProducts) {
        const allMerch = await queryCollection('merch', { limit: 500 });
        products = allMerch
          .filter((item: any) => item.supplierId === supplierId)
          .map((data: any) => ({
            id: data.id,
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
          }));
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
      const allSuppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const supplierDoc = allSuppliers.find((s: any) => s.accessCode === accessCode);

      if (!supplierDoc) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid access code'
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      const supplier: any = supplierDoc;

      // Get their products
      const allMerch = await queryCollection('merch', { limit: 500 });
      const products = allMerch
        .filter((item: any) => item.supplierId === supplier.id)
        .map((data: any) => ({
          id: data.id,
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
        }));

      // Calculate earnings
      let totalEarnings = 0;
      products.forEach((p: any) => {
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
          totalStock: products.reduce((sum: number, p: any) => sum + p.totalStock, 0),
          totalSold: products.reduce((sum: number, p: any) => sum + p.soldStock, 0),
          lowStockItems: products.filter((p: any) => p.isLowStock).length,
          outOfStockItems: products.filter((p: any) => p.isOutOfStock).length,
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
    const suppliers = await queryCollection('merch-suppliers', { limit: 100 });

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
      type,
      code,
      defaultCut,
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
      name: name,
      email: email || null,
      phone: phone || null,
      type: type,
      code: code.toUpperCase(),
      defaultCut: defaultCut || 50,
      contactName: contactName || null,
      address: address || null,
      notes: notes || null,
      accessCode: accessCode,
      totalProducts: 0,
      totalStock: 0,
      totalSold: 0,
      totalRevenue: 0,
      totalDamaged: 0,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await setDocument('merch-suppliers', supplierId, supplierData);

    log.info('[suppliers] Created supplier:', name, '(' + supplierId + ')');

    return new Response(JSON.stringify({
      success: true,
      message: 'Supplier created successfully',
      supplier: { id: supplierId, ...supplierData },
      accessCode: accessCode
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

    await updateDocument('merch-suppliers', supplierId, updates);

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
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const { supplierId, hardDelete } = await request.json();

    if (!supplierId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (hardDelete) {
      await deleteDocument('merch-suppliers', supplierId);

      log.info('[suppliers] Permanently deleted supplier:', supplierId);

      return new Response(JSON.stringify({
        success: true,
        message: 'Supplier permanently deleted'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      await updateDocument('merch-suppliers', supplierId, {
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
