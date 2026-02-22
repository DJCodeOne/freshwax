// src/pages/api/admin/assign-seller.ts
// Assign a seller/artist to merch or release products for payout routing
// Usage: POST { productIds: [...], sellerId, collection: 'merch' | 'releases', adminKey }

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { saUpdateDocument, saQueryCollection } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('[assign-seller]');

const assignSellerSchema = z.object({
  productIds: z.array(z.string().min(1)).optional(),
  sellerId: z.string().optional(),
  sellerName: z.string().optional(),
  category: z.string().optional(),
  categoryName: z.string().optional(),
  productType: z.string().optional(),
  collection: z.enum(['merch', 'releases']).optional(),
  searchTerm: z.string().optional(),
  listAll: z.boolean().optional(),
  adminKey: z.string().optional(),
});

export const prerender = false;

function getServiceAccountKey(env: Record<string, unknown>): string | null {
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
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`assign-seller:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
    const body = await request.json();

    // Admin auth
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = assignSellerSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { productIds, sellerId, sellerName, category, categoryName, productType, collection, searchTerm, listAll } = parsed.data;

    // sellerId, category, categoryName, or productType required if not listing
    if (!sellerId && !category && !categoryName && !productType && !listAll) {
      return ApiErrors.badRequest('sellerId, category, categoryName, or productType required');
    }

    const collectionName = collection || 'merch';

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const serviceAccountKey = getServiceAccountKey(env);

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
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
        products: allProducts.map((p: Record<string, unknown>) => ({
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
      log.info(`[assign-seller] Searching ${collectionName} for: ${searchTerm}`);

      const allProducts = await saQueryCollection(serviceAccountKey, projectId, collectionName, {
        limit: 500
      });

      const searchLower = searchTerm.toLowerCase();
      idsToUpdate = allProducts
        .filter((p: Record<string, unknown>) => {
          const name = (p.name || p.releaseName || '').toLowerCase();
          const artist = (p.artist || p.artistName || p.brand || '').toLowerCase();
          const label = (p.label || '').toLowerCase();
          const category = (p.category || p.categoryName || '').toLowerCase();
          const sku = (p.sku || '').toLowerCase();
          const id = (p.id || '').toLowerCase();
          return name.includes(searchLower) || artist.includes(searchLower) || label.includes(searchLower) || category.includes(searchLower) || sku.includes(searchLower) || id.includes(searchLower);
        })
        .map((p: Record<string, unknown>) => p.id as string);

      log.info(`[assign-seller] Search "${searchTerm}" found ${idsToUpdate.length} products:`, idsToUpdate);

      log.info(`[assign-seller] Found ${idsToUpdate.length} matching products`);
    }

    if (!idsToUpdate.length) {
      return ApiErrors.badRequest('No products to update. Provide productIds or searchTerm.');
    }

    // Build update payload once (same for every product)
    const updateData: Record<string, unknown> = {
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

    // Add category if provided (for fixing category grouping)
    if (category) {
      updateData.category = category;
    }

    // Add categoryName if provided (for fixing display name in dropdowns)
    if (categoryName) {
      updateData.categoryName = categoryName;
    }

    // Add productType if provided (for fixing filter dropdown)
    if (productType) {
      updateData.productType = productType;
    }

    // Batch update all products in parallel (fixes N+1 sequential awaits)
    const settled = await Promise.allSettled(
      idsToUpdate.map((productId) =>
        saUpdateDocument(serviceAccountKey, projectId, collectionName, productId, updateData)
          .then(() => productId)
      )
    );

    const results: string[] = [];
    const errors: string[] = [];

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        log.info(`[assign-seller] Updated ${collectionName}/${result.value} -> sellerId: ${sellerId}`);
      } else {
        errors.push(String(result.reason));
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

  } catch (error: unknown) {
    log.error('[assign-seller] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
