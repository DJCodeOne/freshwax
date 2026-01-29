// src/pages/api/admin/assign-seller.ts
// Assign a seller/artist to merch or release products for payout routing
// Usage: POST { productIds: [...], sellerId, collection: 'merch' | 'releases', adminKey }

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { saUpdateDocument, saQueryCollection } from '../../../lib/firebase-service-account';

export const prerender = false;

function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
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

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const body = await request.json();

    // Admin auth
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { productIds, sellerId, sellerName, categoryName, collection, searchTerm, listAll } = body;

    // sellerId or categoryName required if not listing
    if (!sellerId && !categoryName && !listAll) {
      return new Response(JSON.stringify({ error: 'sellerId or categoryName required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const collectionName = collection || 'merch';
    if (!['merch', 'releases'].includes(collectionName)) {
      return new Response(JSON.stringify({ error: 'collection must be "merch" or "releases"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const serviceAccountKey = getServiceAccountKey(env);

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let idsToUpdate: string[] = productIds || [];

    // If listAll is true, just return all products for inspection
    if (body.listAll) {
      const allProducts = await saQueryCollection(serviceAccountKey, projectId, collectionName, {
        limit: 100
      });

      return new Response(JSON.stringify({
        success: true,
        message: `Found ${allProducts.length} products in ${collectionName}`,
        products: allProducts.map((p: any) => ({
          id: p.id,
          name: p.name || p.releaseName,
          category: p.category,
          categoryName: p.categoryName,
          brand: p.brand,
          label: p.label,
          artist: p.artist || p.artistName,
          sku: p.sku,
          sellerId: p.sellerId,
          supplierId: p.supplierId,
          supplierName: p.supplierName,
          submitterId: p.submitterId,
          artistId: p.artistId
        }))
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // If searchTerm provided, find matching products
    if (searchTerm && !productIds?.length) {
      console.log(`[assign-seller] Searching ${collectionName} for: ${searchTerm}`);

      const allProducts = await saQueryCollection(serviceAccountKey, projectId, collectionName, {
        limit: 500
      });

      const searchLower = searchTerm.toLowerCase();
      idsToUpdate = allProducts
        .filter((p: any) => {
          const name = (p.name || p.releaseName || '').toLowerCase();
          const artist = (p.artist || p.artistName || p.brand || '').toLowerCase();
          const label = (p.label || '').toLowerCase();
          const category = (p.category || p.categoryName || '').toLowerCase();
          const sku = (p.sku || '').toLowerCase();
          const id = (p.id || '').toLowerCase();
          return name.includes(searchLower) || artist.includes(searchLower) || label.includes(searchLower) || category.includes(searchLower) || sku.includes(searchLower) || id.includes(searchLower);
        })
        .map((p: any) => p.id);

      console.log(`[assign-seller] Search "${searchTerm}" found ${idsToUpdate.length} products:`, idsToUpdate);

      console.log(`[assign-seller] Found ${idsToUpdate.length} matching products`);
    }

    if (!idsToUpdate.length) {
      return new Response(JSON.stringify({
        error: 'No products to update. Provide productIds or searchTerm.',
        hint: 'Example: { "searchTerm": "bakkus", "sellerId": "xxx", "collection": "merch" }'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const results: string[] = [];
    const errors: string[] = [];

    for (const productId of idsToUpdate) {
      try {
        const updateData: any = {
          updatedAt: new Date().toISOString()
        };

        // Only set seller fields if sellerId is provided
        if (sellerId) {
          updateData.sellerId = sellerId;

          // For releases, also set artistId
          if (collectionName === 'releases') {
            updateData.artistId = sellerId;
            updateData.submitterId = sellerId;
          }

          // For merch, also set supplierId (used by dashboard queries)
          if (collectionName === 'merch') {
            updateData.supplierId = sellerId;
          }
        }

        // Add seller name if provided
        if (sellerName) {
          updateData.sellerName = sellerName;
          if (collectionName === 'releases') {
            updateData.artistName = sellerName;
          }
          if (collectionName === 'merch') {
            updateData.supplierName = sellerName;
          }
        }

        // Add categoryName if provided (for fixing display name in dropdowns)
        if (categoryName) {
          updateData.categoryName = categoryName;
        }

        await saUpdateDocument(serviceAccountKey, projectId, collectionName, productId, updateData);
        results.push(productId);
        console.log(`[assign-seller] Updated ${collectionName}/${productId} -> sellerId: ${sellerId}`);
      } catch (err) {
        errors.push(`${productId}: ${err}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${results.length} products in ${collectionName}`,
      sellerId: sellerId || null,
      sellerName: sellerName || null,
      categoryName: categoryName || null,
      updated: results,
      errors: errors.length > 0 ? errors : undefined
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[assign-seller] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
