// src/pages/api/get-user-type.ts
// Returns user type info - supports both unified users collection and legacy collections
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

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
    const db = getFirestore();
    
    log.info('[get-user-type] Checking user:', uid);
    
    // Fetch all possible user documents in parallel (including admins collection)
    const [userDoc, artistDoc, customerDoc, adminDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('artists').doc(uid).get(),
      db.collection('customers').doc(uid).get(),
      db.collection('admins').doc(uid).get(),
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
    
    // Hardcoded admin UIDs (document IDs from admins collection)
    const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33'];
    if (ADMIN_UIDS.includes(uid)) {
      isAdmin = true;
      log.info('[get-user-type] Admin by hardcoded UID');
    }
    
    // Check admins collection by UID (document ID = uid)
    if (!isAdmin && adminDoc.exists) {
      isAdmin = true;
      const adminData = adminDoc.data();
      if (!name && adminData?.name) name = adminData.name;
      if (!avatarUrl && adminData?.avatarUrl) avatarUrl = adminData.avatarUrl;
      log.info('[get-user-type] Admin found in admins collection by UID');
    }
    
    // Also check if email exists anywhere in admins collection
    if (!isAdmin) {
      try {
        // Get email from any collection first
        let checkEmail = '';
        if (userDoc.exists) checkEmail = userDoc.data()?.email || '';
        if (!checkEmail && customerDoc.exists) checkEmail = customerDoc.data()?.email || '';
        if (!checkEmail && artistDoc.exists) checkEmail = artistDoc.data()?.email || '';
        
        if (checkEmail) {
          const adminsSnapshot = await db.collection('admins').where('email', '==', checkEmail).limit(1).get();
          if (!adminsSnapshot.empty) {
            isAdmin = true;
            log.info('[get-user-type] Admin found by email in admins collection:', checkEmail);
          }
        }
      } catch (e) {
        log.info('[get-user-type] Could not query admins by email:', e.message);
      }
    }
    
    // Check unified users collection (new system)
    if (userDoc.exists) {
      const userData = userDoc.data();
      
      // displayName is the public/artist name (e.g. "Code One")
      // name is the private/real name (e.g. "Dave Hagon")
      if (userData?.displayName) {
        partnerDisplayName = userData.displayName;
      }
      
      // Set private name
      name = userData?.name || userData?.fullName || name;
      
      // Get avatar
      avatarUrl = userData?.avatarUrl || userData?.photoURL || avatarUrl;
      
      // Check for admin role
      isAdmin = isAdmin || userData?.isAdmin === true || userData?.role === 'admin' || userData?.roles?.admin === true;
      
      // Check roles
      if (userData?.roles) {
        isCustomer = userData.roles.customer === true;
        isArtist = userData.roles.artist === true;
        isDJ = userData.roles.dj === true;
        isMerchSupplier = userData.roles.merchSupplier === true;
      } else {
        // Default: if they exist in users, they're at least a customer
        isCustomer = true;
      }
      
      // Check partner approval
      if (userData?.partnerInfo) {
        isApproved = userData.partnerInfo.approved === true;
      }
      
      // Check root level approved field too
      if (userData?.approved === true) {
        isApproved = true;
      }
      
      log.info('[get-user-type] Unified user found:', { name, partnerDisplayName, isCustomer, isArtist, isDJ, isMerchSupplier, isApproved, isAdmin });
    }
    
    // Check legacy artists collection (backwards compatibility)
    // If document exists in artists collection, they ARE an artist (original behavior)
    // IMPORTANT: artistName from this collection takes priority over users collection
    if (artistDoc.exists) {
      const artistData = artistDoc.data();
      
      // If they exist in artists collection, they're an artist
      // The isArtist field may not exist on older records
      isArtist = true;
      
      // Check for admin role in artists collection
      isAdmin = isAdmin || artistData?.isAdmin === true || artistData?.role === 'admin';
      
      // Check for additional roles
      isDJ = isDJ || artistData?.isDJ === true;
      isMerchSupplier = isMerchSupplier || artistData?.isMerchSupplier === true;
      isApproved = isApproved || artistData?.approved === true;
      
      // artistName from artists collection takes absolute priority
      if (artistData?.artistName) {
        partnerDisplayName = artistData.artistName;
      } else if (!partnerDisplayName && artistData?.name) {
        // Only use artists.name if we don't already have a display name
        partnerDisplayName = artistData.name;
      }
      
      // Only set private name if not already set
      if (!name) {
        name = artistData?.name || artistData?.artistName || '';
      }
      if (!avatarUrl) {
        avatarUrl = artistData?.avatarUrl || artistData?.photoURL || artistData?.imageUrl || '';
      }
      
      log.info('[get-user-type] Legacy artist found:', artistData?.artistName, 'partnerDisplayName:', partnerDisplayName, 'approved:', isApproved);
    }
    
    // Check legacy customers collection (backwards compatibility)
    if (customerDoc.exists) {
      const customerData = customerDoc.data();
      isCustomer = true;
      
      // Prefer displayName, then fullName, then firstName
      if (!name) {
        name = customerData?.displayName || customerData?.fullName || customerData?.name || customerData?.firstName || '';
      }
      
      // Store displayName separately if it exists
      if (!partnerDisplayName && customerData?.displayName) {
        partnerDisplayName = customerData.displayName;
      }
      
      // Get avatar from customers collection
      if (!avatarUrl) {
        avatarUrl = customerData?.avatarUrl || customerData?.photoURL || '';
      }
      
      log.info('[get-user-type] Legacy customer found:', name);
    }
    
    // Get email from any source for admin email check
    let userEmail = '';
    if (userDoc.exists) userEmail = userDoc.data()?.email || '';
    if (!userEmail && customerDoc.exists) userEmail = customerDoc.data()?.email || '';
    if (!userEmail && artistDoc.exists) userEmail = artistDoc.data()?.email || '';
    
    // Hardcoded admin email fallback
    const ADMIN_EMAILS = ['freshwaxonline@gmail.com'];
    if (userEmail && ADMIN_EMAILS.includes(userEmail.toLowerCase())) {
      isAdmin = true;
      log.info('[get-user-type] Admin by email:', userEmail);
    }
    
    // Determine if they have any partner role
    const hasPartnerRole = isArtist || isDJ || isMerchSupplier;
    const isPro = hasPartnerRole && isApproved;
    
    // ADMIN OVERRIDE: Admins get full access to everything
    if (isAdmin) {
      isCustomer = true;
      isArtist = true;
      isDJ = true;
      isMerchSupplier = true;
      isApproved = true;
      log.info('[get-user-type] Admin granted full access');
    }
    
    return new Response(JSON.stringify({
      success: true,
      // Core flags
      isCustomer: isCustomer,
      isArtist: isAdmin ? true : hasPartnerRole,  // Admin or has partner role
      isApproved: isAdmin ? true : isApproved,
      isPro: isAdmin ? true : isPro,
      isAdmin: isAdmin,
      
      // Detailed roles
      roles: {
        customer: isCustomer,
        artist: isArtist,
        dj: isDJ,
        merchSupplier: isMerchSupplier,
        admin: isAdmin
      },
      
      // Names - displayName is the preferred name to show in UI
      displayName: partnerDisplayName || name,
      name: name,
      partnerDisplayName: partnerDisplayName,
      
      // Avatar
      avatarUrl: avatarUrl,
      
      // Computed flags
      canBuy: isCustomer,
      canSell: isAdmin ? true : (hasPartnerRole && isApproved)
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        // Extended cache: 5 min fresh, serve stale for 30 min while revalidating
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800'
      }
    });
  } catch (error) {
    log.error('[get-user-type] Error:', error);
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
