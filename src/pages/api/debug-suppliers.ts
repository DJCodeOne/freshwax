// src/pages/api/debug-suppliers.ts
// Debug endpoint to check supplier data on products
import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import { requireAdminAuth } from '../../lib/admin';

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Allow admin key via query param for browser access
  const keyFromQuery = url.searchParams.get('key');
  if (keyFromQuery) {
    const headers = new Headers(request.headers);
    headers.set('X-Admin-Key', keyFromQuery);
    request = new Request(request.url, { ...request, headers });
  }

  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const [products, users] = await Promise.all([
      queryCollection('merch', { limit: 500 }),
      queryCollection('users', { limit: 500 })
    ]);

    // Get users with supplier role
    const supplierUsers = users.filter((u: any) => {
      const roles = u.roles || {};
      return roles.merchSupplier === true || roles.merchSeller === true || u.isMerchSupplier === true;
    }).map((u: any) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      artistName: u.artistName,
      storeName: u.partnerInfo?.storeName,
      roles: u.roles
    }));

    // Analyze products
    const productsBySupplier: Record<string, any[]> = {};
    const productsByCategory: Record<string, number> = {};
    const productsWithNoSupplier: any[] = [];

    products.forEach((p: any) => {
      const supplierInfo = {
        id: p.id,
        name: p.name,
        category: p.categoryName || p.category || 'No Category',
        supplierId: p.supplierId || null,
        supplierName: p.supplierName || null,
        supplier: p.supplier || null,
        supplierEmail: p.supplierEmail || null,
        createdBy: p.createdBy || null
      };

      // Group by supplier
      const key = p.supplierName || p.supplier || 'No Supplier Set';
      if (!productsBySupplier[key]) productsBySupplier[key] = [];
      productsBySupplier[key].push(supplierInfo);

      // Count by category
      const cat = p.categoryName || p.category || 'No Category';
      productsByCategory[cat] = (productsByCategory[cat] || 0) + 1;

      if (!p.supplierId && !p.supplierName && p.supplierName !== 'Fresh Wax') {
        productsWithNoSupplier.push(supplierInfo);
      }
    });

    return new Response(JSON.stringify({
      success: true,
      totalProducts: products.length,
      supplierUsers,
      categories: productsByCategory,
      productsBySupplier: Object.fromEntries(
        Object.entries(productsBySupplier).map(([k, v]) => [k, { count: v.length, samples: v.slice(0, 3) }])
      ),
      productsWithNoSupplier: productsWithNoSupplier.slice(0, 10)
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
