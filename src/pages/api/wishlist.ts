// src/pages/api/wishlist.ts
// Wishlist management API - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, getDocumentsBatch, arrayUnion, arrayRemove } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Initialize Firebase from runtime env
  const env = locals.runtime.env;


  try {
    // SECURITY: Verify auth token
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user's wishlist
    const customerDoc = await getDocument('users', userId);
    const wishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];

    // If wishlist has items, fetch release details
    if (wishlist.length > 0) {
      // Cap at 50 items to prevent runaway queries
      const itemsToFetch = wishlist.slice(0, 50);

      // Batch fetch all releases in one call instead of N+1 individual queries
      const releaseMap = await getDocumentsBatch('releases', itemsToFetch);

      const releases: any[] = [];
      for (const releaseId of itemsToFetch) {
        const releaseData = releaseMap.get(releaseId);
        if (releaseData) {
          releases.push({
            id: releaseId,
            ...releaseData,
            addedToWishlist: true
          });
        }
      }

      // Sort by wishlist order (most recently added first - reverse of array order)
      releases.sort((a, b) => {
        return itemsToFetch.indexOf(b.id) - itemsToFetch.indexOf(a.id);
      });

      // Return actual found releases count (not stored IDs count)
      return new Response(JSON.stringify({
        success: true,
        wishlist: releases,
        count: releases.length,
        storedCount: wishlist.length // For debugging - shows if some releases were deleted
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      wishlist: [],
      count: 0,
      storedCount: 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[WISHLIST API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get wishlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`wishlist:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase from runtime env
  const env = locals.runtime.env;


  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { releaseId, action } = body;

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();

    if (action === 'add') {
      // Pre-check wishlist size (soft cap - not atomic but prevents runaway growth)
      const customerDoc = await getDocument('users', userId);
      const currentWishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];
      if (currentWishlist.length >= 500) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Wishlist is full (max 500 items)'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Atomic arrayUnion prevents lost items under concurrent writes
      await arrayUnion('users', userId, 'wishlist', [releaseId], {
        wishlistUpdatedAt: now
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Added to wishlist',
        inWishlist: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'remove') {
      // Atomic arrayRemove prevents lost data under concurrent writes
      await arrayRemove('users', userId, 'wishlist', [releaseId], {
        wishlistUpdatedAt: now
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Removed from wishlist',
        inWishlist: false
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'toggle') {
      // Read to determine current state, then use atomic operation for the mutation
      const customerDoc = await getDocument('users', userId);
      const currentWishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];
      const isInWishlist = currentWishlist.includes(releaseId);

      if (isInWishlist) {
        await arrayRemove('users', userId, 'wishlist', [releaseId], {
          wishlistUpdatedAt: now
        });
        return new Response(JSON.stringify({
          success: true,
          message: 'Removed from wishlist',
          inWishlist: false
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await arrayUnion('users', userId, 'wishlist', [releaseId], {
          wishlistUpdatedAt: now
        });
        return new Response(JSON.stringify({
          success: true,
          message: 'Added to wishlist',
          inWishlist: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

    } else if (action === 'check') {
      // Check if item is in wishlist
      const customerDoc = await getDocument('users', userId);
      const currentWishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];
      const isInWishlist = currentWishlist.includes(releaseId);

      return new Response(JSON.stringify({
        success: true,
        inWishlist: isInWishlist
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action. Use: add, remove, toggle, or check'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[WISHLIST API] Error:', error);
    console.error('[WISHLIST API] Error stack:', error instanceof Error ? error.stack : undefined);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update wishlist',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
