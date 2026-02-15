// src/pages/api/user/dashboard-access.ts
// Unified endpoint for checking user roles, admin status, and dashboard access
// Replaces client-side Firestore reads in layouts and dashboard pages
// GET: Returns user roles, admin status, subscription, and seller data
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const { userId, email, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check admin status
    let isAdmin = false;
    try {
      const adminDoc = await getDocument('admins', userId);
      if (adminDoc) isAdmin = true;
    } catch (e) {}

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
      } catch (e) {}
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
    } catch (e) {}

    // Check merch seller data
    let merchSellerData: any = null;
    try {
      merchSellerData = await getDocument('merch-sellers', userId);
    } catch (e) {}

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
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to check access'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
