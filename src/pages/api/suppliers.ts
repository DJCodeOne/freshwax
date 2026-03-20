// src/pages/api/suppliers.ts
// Manage merch suppliers/consignment partners - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument, updateDocument, deleteDocument } from '../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../lib/admin';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

export const prerender = false;

// Helper to initialize services
function initServices(locals: App.Locals) {
  const env = locals?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
}

const log = createLogger('suppliers');

// GET - List all suppliers or get specific supplier
export const GET: APIRoute = async ({ request, url, locals }) => {
  initServices(locals);

  try {
    const params = url.searchParams;
    const supplierId = params.get('id');
    const includeProducts = params.get('products') === 'true';
    const accessCode = params.get('code');

    // Supplier portal access via code - no admin auth needed
    // But listing all suppliers or getting by ID requires admin auth
    if (!accessCode) {
      const authError = await requireAdminAuth(request, locals);
      if (authError) return authError;
    }

    if (supplierId) {
      // Get specific supplier
      const supplier = await getDocument('merch-suppliers', supplierId);

      if (!supplier) {
        return ApiErrors.notFound('Supplier not found');
      }

      // Get their products if requested
      let products: Record<string, unknown>[] = [];
      if (includeProducts) {
        const supplierMerch = await queryCollection('merch', {
          filters: [{ field: 'supplierId', op: 'EQUAL', value: supplierId }],
          limit: 200
        });
        products = supplierMerch
          .map((data: Record<string, unknown>) => ({
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

      return successResponse({ supplier: supplier,
        products: products }, 200, { headers: { 'Cache-Control': 'private, max-age=60' } });
    }

    // Supplier portal access via code
    if (accessCode) {
      const matchedSuppliers = await queryCollection('merch-suppliers', {
        filters: [{ field: 'accessCode', op: 'EQUAL', value: accessCode }],
        limit: 1
      });
      const supplierDoc = matchedSuppliers[0] || null;

      if (!supplierDoc) {
        return ApiErrors.unauthorized('Invalid access code');
      }

      const supplier = supplierDoc as Record<string, unknown>;

      // Get their products (server-side filter by supplierId)
      const supplierMerch = await queryCollection('merch', {
        filters: [{ field: 'supplierId', op: 'EQUAL', value: supplier.id }],
        limit: 200
      });
      const products = supplierMerch
        .map((data: Record<string, unknown>) => ({
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
      products.forEach((p: Record<string, unknown>) => {
        totalEarnings += ((p.retailPrice as number) * (p.soldStock as number) * ((p.supplierCut as number) / 100));
      });

      return successResponse({ supplier: {
          id: supplier.id,
          name: supplier.name,
          email: supplier.email,
          type: supplier.type
        },
        products: products,
        stats: {
          totalProducts: products.length,
          totalStock: products.reduce((sum: number, p: Record<string, unknown>) => sum + (p.totalStock as number), 0),
          totalSold: products.reduce((sum: number, p: Record<string, unknown>) => sum + (p.soldStock as number), 0),
          lowStockItems: products.filter((p: Record<string, unknown>) => p.isLowStock).length,
          outOfStockItems: products.filter((p: Record<string, unknown>) => p.isOutOfStock).length,
          totalEarnings: totalEarnings
        } }, 200, { headers: { 'Cache-Control': 'private, max-age=60' } });
    }

    // List all suppliers (admin only)
    // Combine from both merch-suppliers collection AND users with merchSupplier role
    const [merchSuppliers, allUsers, allMerch] = await Promise.all([
      queryCollection('merch-suppliers', { limit: 100 }),
      queryCollection('users', { limit: 500 }),
      queryCollection('merch', { limit: 500 })
    ]);

    // Helper to calculate supplier stats from merch products
    function calcSupplierStats(supplierId: string, supplierName?: string) {
      const products = allMerch.filter((m: Record<string, unknown>) =>
        m.supplierId === supplierId ||
        (supplierName && m.supplierName === supplierName)
      );
      return {
        totalProducts: products.length,
        totalStock: products.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.totalStock as number) || (p.stock as number) || 0), 0),
        totalSold: products.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.totalSold as number) || (p.soldStock as number) || 0), 0)
      };
    }

    // Convert users with merchSupplier/merchSeller role to supplier format
    // Firestore user documents have deeply nested dynamic shape — cast partnerInfo for property access
    const userSuppliers = allUsers
      .filter((u: Record<string, unknown>) => {
        const roles = (u.roles || {}) as Record<string, unknown>;
        return (roles.merchSupplier === true || roles.merchSeller === true) && u.deleted !== true;
      })
      .map((u: Record<string, unknown>) => {
        const partnerInfo = u.partnerInfo as Record<string, unknown> | undefined;
        const supplierName = partnerInfo?.storeName || partnerInfo?.displayName || u.displayName || 'Unknown';
        const stats = calcSupplierStats(u.id as string, supplierName as string);
        return {
          id: u.id,
          name: supplierName,
          email: u.email,
          phone: u.phone || '',
          type: partnerInfo?.type || 'other',
          code: ((u.displayName as string) || 'USR').substring(0, 3).toUpperCase(),
          defaultCut: partnerInfo?.defaultCut || 50,
          contactName: u.fullName || u.displayName || '',
          notes: partnerInfo?.notes || '',
          accessCode: null, // User-based suppliers use auth, not access codes
          totalProducts: stats.totalProducts,
          totalStock: stats.totalStock,
          totalSold: stats.totalSold,
          totalRevenue: u.totalEarnings || 0,
          active: u.approved === true || partnerInfo?.approved === true,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          source: 'users' // Track source for admin UI
        };
      });

    // Update merch-suppliers with calculated stats too
    const merchSuppliersWithStats = merchSuppliers.map((s: Record<string, unknown>) => {
      const stats = calcSupplierStats(s.id, s.name);
      return {
        ...s,
        totalProducts: stats.totalProducts || s.totalProducts || 0,
        totalStock: stats.totalStock || s.totalStock || 0,
        totalSold: stats.totalSold || s.totalSold || 0,
        source: 'merch-suppliers'
      };
    });

    // Combine both sources, avoiding duplicates by email
    const supplierEmails = new Set(merchSuppliers.map((s: Record<string, unknown>) => (s.email as string)?.toLowerCase()));
    const combinedSuppliers = [
      ...merchSuppliersWithStats,
      ...userSuppliers.filter((u: Record<string, unknown>) => !u.email || !supplierEmails.has((u.email as string).toLowerCase()))
    ];

    log.info('[suppliers] Listed', combinedSuppliers.length, 'suppliers (', merchSuppliers.length, 'legacy +', userSuppliers.length, 'users)');

    return successResponse({ count: combinedSuppliers.length,
      suppliers: combinedSuppliers }, 200, { headers: { 'Cache-Control': 'private, max-age=60' } });

  } catch (error: unknown) {
    log.error('[suppliers] GET Error:', error);

    return ApiErrors.serverError('Failed to fetch suppliers');
  }
};

// POST - Create new supplier (Admin only)
export const POST: APIRoute = async ({ request, locals }) => {
  initServices(locals);

  try {
    const body = await parseJsonBody(request);

    // Verify admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

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
      return ApiErrors.badRequest('Name, type, and code are required');
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

    return successResponse({ message: 'Supplier created successfully',
      supplier: { id: supplierId, ...supplierData },
      accessCode: accessCode });

  } catch (error: unknown) {
    log.error('[suppliers] POST Error:', error);

    return ApiErrors.serverError('Failed to create supplier');
  }
};

// PUT - Update supplier (Admin only)
export const PUT: APIRoute = async ({ request, locals }) => {
  initServices(locals);

  try {
    const body = await parseJsonBody(request);

    // Verify admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { supplierId, ...updates } = body;

    if (!supplierId) {
      return ApiErrors.badRequest('Supplier ID is required');
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

    return successResponse({ message: 'Supplier updated successfully' });

  } catch (error: unknown) {
    log.error('[suppliers] PUT Error:', error);

    return ApiErrors.serverError('Failed to update supplier');
  }
};

// DELETE - Deactivate or permanently delete supplier (Admin only)
export const DELETE: APIRoute = async ({ request, locals }) => {
  initServices(locals);

  try {
    const body = await parseJsonBody(request);

    // Verify admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { supplierId, hardDelete } = body;

    if (!supplierId) {
      return ApiErrors.badRequest('Supplier ID is required');
    }

    if (hardDelete) {
      await deleteDocument('merch-suppliers', supplierId);

      log.info('[suppliers] Permanently deleted supplier:', supplierId);

      return successResponse({ message: 'Supplier permanently deleted' });
    } else {
      await updateDocument('merch-suppliers', supplierId, {
        active: false,
        deactivatedAt: new Date().toISOString()
      });

      log.info('[suppliers] Deactivated supplier:', supplierId);

      return successResponse({ message: 'Supplier deactivated successfully' });
    }

  } catch (error: unknown) {
    log.error('[suppliers] DELETE Error:', error);

    return ApiErrors.serverError('Failed to delete supplier');
  }
};
