// src/pages/api/get-user-type.ts
// Returns user type info - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');
  const authEmail = url.searchParams.get('email'); // Email from Firebase Auth

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
    const [userDoc, artistDoc, customerDoc, adminDoc, vinylSellerDoc] = await Promise.all([
      getDocument('users', uid),
      getDocument('artists', uid),
      getDocument('customers', uid),
      getDocument('admins', uid),
      getDocument('vinylSellers', uid),
    ]);

    let name = '';
    let isCustomer = false;
    let isArtist = false;
    let isDJ = false;
    let isMerchSupplier = false;
    let isVinylSeller = false;
    let isApproved = false;
    let isAdmin = false;
    let partnerDisplayName = '';
    let avatarUrl = '';

    // Hardcoded admin UIDs
    const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];
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
        isMerchSupplier = userDoc.roles.merchSupplier === true || userDoc.roles.merchSeller === true;
        isVinylSeller = userDoc.roles.vinylSeller === true;
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

    // Check legacy customers collection - avatarUrl from customers takes priority (upload-avatar saves here)
    if (customerDoc) {
      isCustomer = true;
      if (!name) {
        name = customerDoc.displayName || customerDoc.fullName || customerDoc.name || customerDoc.firstName || '';
      }
      if (!partnerDisplayName && customerDoc.displayName) {
        partnerDisplayName = customerDoc.displayName;
      }
      // Customer avatarUrl takes precedence over users collection (upload-avatar saves to customers)
      if (customerDoc.avatarUrl) {
        avatarUrl = customerDoc.avatarUrl;
      } else if (!avatarUrl) {
        avatarUrl = customerDoc.photoURL || '';
      }
      // Check for vinyl seller flag in customers
      isVinylSeller = isVinylSeller || customerDoc.isVinylSeller === true;
    }

    // Check vinylSellers collection
    if (vinylSellerDoc) {
      isVinylSeller = true;
      isApproved = isApproved || vinylSellerDoc.approved === true;
      if (!partnerDisplayName && vinylSellerDoc.storeName) {
        partnerDisplayName = vinylSellerDoc.storeName;
      }
    }

    // Check for admin email - include authEmail from Firebase Auth as fallback
    let userEmail = userDoc?.email || customerDoc?.email || artistDoc?.email || authEmail || '';
    const ADMIN_EMAILS = ['freshwaxonline@gmail.com', 'davidhagon@gmail.com'];
    if (userEmail && ADMIN_EMAILS.includes(userEmail.toLowerCase())) {
      isAdmin = true;
    }

    const hasPartnerRole = isArtist || isDJ || isMerchSupplier || isVinylSeller;
    const isPro = hasPartnerRole && isApproved;

    // Get referral code from user document (generated when upgrading to Pro)
    const referralCode = userDoc?.referralCode || null;

    // If no avatarUrl found in Firestore, check if one exists in R2
    console.log('[get-user-type] avatarUrl from Firestore:', avatarUrl || 'none');
    if (!avatarUrl) {
      const r2PublicUrl = env?.R2_PUBLIC_URL || import.meta.env.R2_PUBLIC_URL || 'https://pub-5c0458d0721c4946884a203f2ca66ee0.r2.dev';
      const potentialAvatarUrl = `${r2PublicUrl}/avatars/${uid}.webp`;
      console.log('[get-user-type] Checking R2 for avatar:', potentialAvatarUrl);
      try {
        const avatarCheck = await fetch(potentialAvatarUrl, { method: 'HEAD' });
        console.log('[get-user-type] R2 avatar check response:', avatarCheck.status);
        if (avatarCheck.ok) {
          avatarUrl = `${potentialAvatarUrl}?t=${Date.now()}`;
          console.log('[get-user-type] Found avatar in R2:', avatarUrl);
        }
      } catch (e) {
        console.log('[get-user-type] R2 avatar check failed:', e);
      }
    }

    // Admin override
    if (isAdmin) {
      isCustomer = true;
      isArtist = true;
      isDJ = true;
      isMerchSupplier = true;
      isVinylSeller = true;
      isApproved = true;
    }

    return new Response(JSON.stringify({
      success: true,
      isCustomer,
      isArtist: isAdmin ? true : hasPartnerRole,
      isApproved: isAdmin ? true : isApproved,
      isPro: isAdmin ? true : isPro,
      isAdmin,
      isVinylSeller,
      roles: {
        customer: isCustomer,
        artist: isArtist,
        dj: isDJ,
        merchSupplier: isMerchSupplier,
        vinylSeller: isVinylSeller,
        admin: isAdmin
      },
      displayName: partnerDisplayName || name,
      name,
      partnerDisplayName,
      avatarUrl,
      canBuy: isCustomer,
      canSell: isAdmin ? true : (hasPartnerRole && isApproved),
      referralCode
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
