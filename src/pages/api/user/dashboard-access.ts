// src/pages/api/user/dashboard-access.ts
// Unified endpoint for checking user roles, admin status, and dashboard access
// Replaces client-side Firestore reads in layouts and dashboard pages
// GET: Returns user roles, admin status, subscription, and seller data
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dashboard-access:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const { userId, email, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    // Check admin status
    let isAdmin = false;
    try {
      const adminDoc = await getDocument('admins', userId);
      if (adminDoc) isAdmin = true;
    } catch (e) {
      console.error('[dashboard-access] Failed to check admin status:', e instanceof Error ? e.message : e);
    }

    // Get user document
    const userData = await getDocument('users', userId);
    const roles = userData?.roles || {};
    const pendingRoles = userData?.pendingRoles || {};
    const subscription = userData?.subscription || {};

    // Check subscription status
    const isPlus = subscription.tier === 'pro' &&
      subscription.expiresAt &&
      new Date(subscription.expiresAt) > new Date();

    // Check artist document if no roles found in users collection
    let artistData: any = null;
    if (!roles.artist && !roles.merchSeller && !roles.vinylSeller) {
      try {
        artistData = await getDocument('artists', userId);
        if (artistData) {
          if (artistData.isArtist !== false) roles.artist = true;
          if (artistData.isMerchSupplier) roles.merchSeller = true;
          if (artistData.isVinylSeller) roles.vinylSeller = true;
        }
      } catch (e) {
        console.error('[dashboard-access] Failed to fetch artist data:', e instanceof Error ? e.message : e);
      }
    }

    // Check vinyl seller data
    let sellerData: any = null;
    let isVinylSeller = roles.vinylSeller === true || userData?.isVinylSeller === true;

    if (!isVinylSeller && artistData?.isVinylSeller) {
      isVinylSeller = true;
    }

    try {
      sellerData = await getDocument('vinyl-sellers', userId);
      if (sellerData && !isVinylSeller) {
        isVinylSeller = sellerData.approved !== false;
      }
    } catch (e) {
      console.error('[dashboard-access] Failed to fetch vinyl seller data:', e instanceof Error ? e.message : e);
    }

    // Check merch seller data
    let merchSellerData: any = null;
    try {
      merchSellerData = await getDocument('merch-sellers', userId);
    } catch (e) {
      console.error('[dashboard-access] Failed to fetch merch seller data:', e instanceof Error ? e.message : e);
    }

    // Admin override for roles
    if (isAdmin && !roles.artist && !roles.merchSeller && !roles.vinylSeller) {
      roles.artist = true;
      roles.merchSeller = true;
      roles.vinylSeller = true;
    }

    return new Response(JSON.stringify({
      success: true,
      isAdmin,
      roles: {
        artist: roles.artist || false,
        merchSeller: roles.merchSeller || false,
        vinylSeller: isVinylSeller || false,
        dj: roles.dj || false,
        djEligible: roles.djEligible || false
      },
      pendingRoles,
      subscription: {
        tier: subscription.tier || 'free',
        isPlus,
        expiresAt: subscription.expiresAt || null
      },
      displayName: userData?.displayName || userData?.name || email || '',
      email: userData?.email || email || '',
      storeName: sellerData?.storeName || null,
      merchBalance: merchSellerData?.balance || 0,
      merchPendingBalance: merchSellerData?.pendingBalance || 0,
      merchCommissionRate: merchSellerData?.commissionRate || 15,
      businessName: pendingRoles?.merchSeller?.businessName || userData?.displayName || '',
      createdAt: userData?.createdAt || null,
      isApproved: userData?.approved || false
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('[dashboard-access] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to check access');
  }
};
