// src/pages/api/check-duplicates.ts
// OPTIMIZED: Shares ownership cache with check-ownership.ts
// Check if cart items are duplicates of previous purchases

import type { APIRoute } from 'astro';
import { queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, jsonResponse } from '../../lib/api-utils';
import { z } from 'zod';

const CartItemSchema = z.object({
  type: z.string().max(50).nullish(),
  productType: z.string().max(50).nullish(),
  releaseId: z.string().max(200).nullish(),
  productId: z.string().max(200).nullish(),
  id: z.string().max(200).nullish(),
  trackId: z.string().max(200).nullish(),
}).passthrough();

const CheckDuplicatesSchema = z.object({
  cartItems: z.array(CartItemSchema).max(100),
}).passthrough();

const log = createLogger('check-duplicates');

export const prerender = false;

// Server-side cache for ownership data - shared pattern with check-ownership
const ownershipCache = new Map<string, { data: { ownedReleases: Set<string>; ownedTracks: Map<string, Set<string>> }; expires: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getOwnershipData(userId: string): Promise<{ 
  ownedReleases: Set<string>; 
  ownedTracks: Map<string, Set<string>> 
}> {
  // Check cache first
  const cached = ownershipCache.get(userId);
  if (cached && Date.now() < cached.expires) {
    log.info('[check-duplicates] Using cached ownership data for', userId);
    return cached.data;
  }
  
  // Query orders for this customer (limit to prevent runaway)
  const orders = await queryCollection('orders', {
    filters: [{ field: 'customer.userId', op: 'EQUAL', value: userId }],
    limit: 200
  });

  const ownedReleases = new Set<string>();
  const ownedTracks = new Map<string, Set<string>>();

  orders.forEach(order => {
    if (order.items && Array.isArray(order.items)) {
      order.items.forEach((item: Record<string, unknown>) => {
        const itemType = item.type || item.productType;
        const releaseId = item.releaseId || item.productId || item.id;
        
        // Skip non-audio items
        if (itemType === 'merch') return;
        
        if (itemType === 'digital' || itemType === 'release' || itemType === 'vinyl') {
          // Full release purchase (vinyl includes digital) - they own all tracks
          ownedReleases.add(releaseId);
        } else if (itemType === 'track' && item.trackId) {
          // Single track purchase
          if (!ownedTracks.has(releaseId)) {
            ownedTracks.set(releaseId, new Set());
          }
          ownedTracks.get(releaseId)!.add(item.trackId);
        }
      });
    }
  });
  
  const data = { ownedReleases, ownedTracks };
  
  // Cache the result
  ownershipCache.set(userId, { data, expires: Date.now() + CACHE_TTL });
  
  return data;
}

export const POST: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`check-duplicates:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify the authenticated user — require Firebase auth
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = CheckDuplicatesSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return jsonResponse({ duplicates: [] });
    }
    const { cartItems } = parseResult.data;
    
    // Get cached ownership data
    const { ownedReleases, ownedTracks } = await getOwnershipData(userId);
    
    // Check cart items for duplicates
    const duplicates: { item: Record<string, unknown>; reason: string }[] = [];
    
    for (const item of cartItems) {
      const itemType = item.type || item.productType;
      const releaseId = item.releaseId || item.productId || item.id;
      
      // Skip merch - can buy duplicates
      if (itemType === 'merch') continue;
      
      if (itemType === 'digital' || itemType === 'release') {
        // Trying to buy a full release they already own
        if (ownedReleases.has(releaseId)) {
          duplicates.push({
            item,
            reason: 'You already own this release'
          });
        }
      } else if (itemType === 'vinyl') {
        // Vinyl is fine even if they own digital - they might want physical
      } else if (itemType === 'track') {
        // Check if they own the full release (which includes this track)
        if (ownedReleases.has(releaseId)) {
          duplicates.push({
            item,
            reason: 'You already own the full release that includes this track'
          });
        }
        // Or check if they already bought this specific track
        else if (item.trackId && ownedTracks.has(releaseId) && ownedTracks.get(releaseId)!.has(item.trackId)) {
          duplicates.push({
            item,
            reason: 'You already own this track'
          });
        }
      }
    }
    
    log.info('[check-duplicates] User:', userId, 'Owned releases:', ownedReleases.size, 'Duplicates found:', duplicates.length);
    
    return jsonResponse({ duplicates, ownedReleases: [...ownedReleases] });
    
  } catch (error: unknown) {
    log.error('[check-duplicates] Error:', error);
    return ApiErrors.serverError('Failed to check duplicates');
  }
};
