// src/pages/api/get-user-type.ts
// Returns user type info - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');

  if (!uid) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Missing uid'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Fetch all possible user documents in parallel
    const [userDoc, artistDoc, customerDoc, adminDoc] = await Promise.all([
      getDocument('users', uid),
      getDocument('artists', uid),
      getDocument('customers', uid),
      getDocument('admins', uid),
    ]);

    let name = '';
    let isCustomer = false;
    let isArtist = false;
    let isDJ = false;
    let isMerchSupplier = false;
    let isApproved = false;
    let isAdmin = false;
    let partnerDisplayName = '';
    let avatarUrl = '';

    // Hardcoded admin UIDs
    const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33'];
    if (ADMIN_UIDS.includes(uid)) {
      isAdmin = true;
    }

    // Check admins collection
    if (!isAdmin && adminDoc) {
      isAdmin = true;
      if (!name && adminDoc.name) name = adminDoc.name;
      if (!avatarUrl && adminDoc.avatarUrl) avatarUrl = adminDoc.avatarUrl;
    }

    // Check unified users collection
    if (userDoc) {
      if (userDoc.displayName) {
        partnerDisplayName = userDoc.displayName;
      }

      name = userDoc.name || userDoc.fullName || name;
      avatarUrl = userDoc.avatarUrl || userDoc.photoURL || avatarUrl;

      isAdmin = isAdmin || userDoc.isAdmin === true || userDoc.role === 'admin' || userDoc.roles?.admin === true;

      if (userDoc.roles) {
        isCustomer = userDoc.roles.customer === true;
        isArtist = userDoc.roles.artist === true;
        isDJ = userDoc.roles.dj === true || userDoc.roles.djEligible === true;
        isMerchSupplier = userDoc.roles.merchSupplier === true;
      } else {
        isCustomer = true;
      }

      if (userDoc.partnerInfo) {
        isApproved = userDoc.partnerInfo.approved === true;
      }
      if (userDoc.approved === true) {
        isApproved = true;
      }
    }

    // Check legacy artists collection
    if (artistDoc) {
      isArtist = true;
      isAdmin = isAdmin || artistDoc.isAdmin === true || artistDoc.role === 'admin';
      isDJ = isDJ || artistDoc.isDJ === true;
      isMerchSupplier = isMerchSupplier || artistDoc.isMerchSupplier === true;
      isApproved = isApproved || artistDoc.approved === true;

      if (artistDoc.artistName) {
        partnerDisplayName = artistDoc.artistName;
      } else if (!partnerDisplayName && artistDoc.name) {
        partnerDisplayName = artistDoc.name;
      }

      if (!name) {
        name = artistDoc.name || artistDoc.artistName || '';
      }
      if (!avatarUrl) {
        avatarUrl = artistDoc.avatarUrl || artistDoc.photoURL || artistDoc.imageUrl || '';
      }
    }

    // Check legacy customers collection
    if (customerDoc) {
      isCustomer = true;
      if (!name) {
        name = customerDoc.displayName || customerDoc.fullName || customerDoc.name || customerDoc.firstName || '';
      }
      if (!partnerDisplayName && customerDoc.displayName) {
        partnerDisplayName = customerDoc.displayName;
      }
      if (!avatarUrl) {
        avatarUrl = customerDoc.avatarUrl || customerDoc.photoURL || '';
      }
    }

    // Check for admin email
    let userEmail = userDoc?.email || customerDoc?.email || artistDoc?.email || '';
    const ADMIN_EMAILS = ['freshwaxonline@gmail.com', 'davidhagon@gmail.com'];
    if (userEmail && ADMIN_EMAILS.includes(userEmail.toLowerCase())) {
      isAdmin = true;
    }

    const hasPartnerRole = isArtist || isDJ || isMerchSupplier;
    const isPro = hasPartnerRole && isApproved;

    // Admin override
    if (isAdmin) {
      isCustomer = true;
      isArtist = true;
      isDJ = true;
      isMerchSupplier = true;
      isApproved = true;
    }

    return new Response(JSON.stringify({
      success: true,
      isCustomer,
      isArtist: isAdmin ? true : hasPartnerRole,
      isApproved: isAdmin ? true : isApproved,
      isPro: isAdmin ? true : isPro,
      isAdmin,
      roles: {
        customer: isCustomer,
        artist: isArtist,
        dj: isDJ,
        merchSupplier: isMerchSupplier,
        admin: isAdmin
      },
      displayName: partnerDisplayName || name,
      name,
      partnerDisplayName,
      avatarUrl,
      canBuy: isCustomer,
      canSell: isAdmin ? true : (hasPartnerRole && isApproved)
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800'
      }
    });
  } catch (error) {
    console.error('[get-user-type] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch user type',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
