// src/pages/api/bulk-update-supplier.ts
// Bulk update products to set supplier by category
import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import { saUpdateDocument } from '../../lib/firebase-service-account';
import { requireAdminAuth } from '../../lib/admin';
import { d1UpsertMerch } from '../../lib/d1-catalog';

export const prerender = false;

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
  if (!serviceAccountKey) throw new Error('Firebase service account not configured');
  return { key: serviceAccountKey, projectId };
}

export const POST: APIRoute = async ({ request, url, locals }) => {
  // Allow admin key via query param
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
    const body = await request.json();
    const { categories, supplierName, supplierId, dryRun = true } = body;

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'categories array is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!supplierName) {
      return new Response(JSON.stringify({
        success: false,
        error: 'supplierName is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const products = await queryCollection('merch', { limit: 500 });

    // Find products matching categories
    const matchingProducts = products.filter((p: any) => {
      const cat = (p.categoryName || p.category || '').toLowerCase();
      return categories.some((c: string) => cat.includes(c.toLowerCase()));
    });

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true,
        dryRun: true,
        message: `Would update ${matchingProducts.length} products to supplier "${supplierName}"`,
        products: matchingProducts.map((p: any) => ({
          id: p.id,
          name: p.name,
          category: p.categoryName || p.category,
          currentSupplier: p.supplierName || p.supplier || 'Not set'
        }))
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Actually update the products
    const { key: serviceAccountKey, projectId } = getServiceAccountKey(env);
    const db = env?.DB;
    let updated = 0;
    let failed = 0;

    for (const product of matchingProducts) {
      try {
        const updateData = {
          supplierName: supplierName,
          supplierId: supplierId || null,
          updatedAt: new Date().toISOString()
        };

        await saUpdateDocument(serviceAccountKey, projectId, 'merch', product.id, updateData);

        // Also update D1
        if (db) {
          try {
            const updatedProduct = { ...product, ...updateData };
            await d1UpsertMerch(db, product.id, updatedProduct);
          } catch (e) {
            // D1 error is non-critical
          }
        }

        updated++;
      } catch (e) {
        failed++;
        console.error('Failed to update product:', product.id, e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${updated} products to supplier "${supplierName}"`,
      updated,
      failed,
      totalMatched: matchingProducts.length
    }), {
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
