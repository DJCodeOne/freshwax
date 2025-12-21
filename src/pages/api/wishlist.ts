// src/pages/api/wishlist.ts
// Wishlist management API - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, setDocument, updateDocument , initFirebaseEnv } from '../../lib/firebase-rest';

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Initialize Firebase from runtime env
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {

    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user's wishlist
    const customerDoc = await getDocument('customers', userId);
    const wishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];

    // If wishlist has items, fetch release details
    if (wishlist.length > 0) {
      const releases: any[] = [];

      // Fetch each release individually (REST API doesn't support __name__ in)
      for (const releaseId of wishlist) {
        try {
          const releaseData = await getDocument('releases', releaseId);
          if (releaseData) {
            releases.push({
              id: releaseId,
              ...releaseData,
              addedToWishlist: true
            });
          }
        } catch (e) {
          // Release might have been deleted
          console.warn('[WISHLIST] Release not found:', releaseId);
        }
      }

      // Sort by wishlist order (most recently added first - reverse of array order)
      releases.sort((a, b) => {
        return wishlist.indexOf(b.id) - wishlist.indexOf(a.id);
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

  } catch (error: any) {
    console.error('[WISHLIST API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get wishlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase from runtime env
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {

    const body = await request.json();
    const { userId, releaseId, action } = body;

    if (!userId || !releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and Release ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();

    if (action === 'add') {
      // Get current wishlist and add new item
      const customerDoc = await getDocument('customers', userId);
      const currentWishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];

      if (!currentWishlist.includes(releaseId)) {
        currentWishlist.push(releaseId);
      }

      await setDocument('customers', userId, {
        ...(customerDoc || {}),
        wishlist: currentWishlist,
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
      // Remove from wishlist
      const customerDoc = await getDocument('customers', userId);
      const currentWishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];
      const newWishlist = currentWishlist.filter((id: string) => id !== releaseId);

      // Use setDocument to ensure doc exists
      await setDocument('customers', userId, {
        ...(customerDoc || {}),
        wishlist: newWishlist,
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
      // Toggle wishlist status
      const customerDoc = await getDocument('customers', userId);
      const currentWishlist = Array.isArray(customerDoc?.wishlist) ? customerDoc.wishlist : [];
      const isInWishlist = currentWishlist.includes(releaseId);

      if (isInWishlist) {
        // Remove from wishlist
        const newWishlist = currentWishlist.filter((id: string) => id !== releaseId);
        // Use setDocument to ensure doc exists (updateDocument fails on non-existent docs)
        await setDocument('customers', userId, {
          ...(customerDoc || {}),
          wishlist: newWishlist,
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
        // Add to wishlist
        currentWishlist.push(releaseId);
        await setDocument('customers', userId, {
          ...(customerDoc || {}),
          wishlist: currentWishlist,
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
      const customerDoc = await getDocument('customers', userId);
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

  } catch (error: any) {
    console.error('[WISHLIST API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to update wishlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
