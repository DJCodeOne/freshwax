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
    
    // Fetch all possible user documents in parallel
    const [userDoc, artistDoc, customerDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('artists').doc(uid).get(),
      db.collection('customers').doc(uid).get(),
    ]);
    
    let name = '';
    let isCustomer = false;
    let isArtist = false;
    let isDJ = false;
    let isMerchSupplier = false;
    let isApproved = false;
    let partnerDisplayName = '';
    let avatarUrl = '';
    
    // Check unified users collection first (new system)
    if (userDoc.exists) {
      const userData = userDoc.data();
      name = userData?.fullName || userData?.name || '';
      avatarUrl = userData?.avatarUrl || userData?.photoURL || '';
      
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
        partnerDisplayName = userData.partnerInfo.displayName || '';
      }
      
      log.info('[get-user-type] Unified user found:', { name, isCustomer, isArtist, isDJ, isMerchSupplier, isApproved });
    }
    
    // Check legacy artists collection (backwards compatibility)
    // If document exists in artists collection, they ARE an artist (original behavior)
    if (artistDoc.exists) {
      const artistData = artistDoc.data();
      
      // If they exist in artists collection, they're an artist
      // The isArtist field may not exist on older records
      isArtist = true;
      
      // Check for additional roles
      isDJ = isDJ || artistData?.isDJ === true;
      isMerchSupplier = isMerchSupplier || artistData?.isMerchSupplier === true;
      isApproved = isApproved || artistData?.approved === true;
      
      if (!partnerDisplayName) {
        partnerDisplayName = artistData?.artistName || artistData?.name || '';
      }
      if (!name) {
        name = artistData?.name || artistData?.artistName || '';
      }
      if (!avatarUrl) {
        avatarUrl = artistData?.avatarUrl || artistData?.photoURL || artistData?.imageUrl || '';
      }
      
      log.info('[get-user-type] Legacy artist found:', artistData?.artistName, 'approved:', isApproved);
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
    
    // Determine if they have any partner role
    const hasPartnerRole = isArtist || isDJ || isMerchSupplier;
    const isPro = hasPartnerRole && isApproved;
    
    return new Response(JSON.stringify({
      success: true,
      // Core flags
      isCustomer: isCustomer,
      isArtist: hasPartnerRole,  // Keep for backwards compatibility
      isApproved: isApproved,
      isPro: isPro,
      
      // Detailed roles
      roles: {
        customer: isCustomer,
        artist: isArtist,
        dj: isDJ,
        merchSupplier: isMerchSupplier
      },
      
      // Names - name is the display name to show in UI
      name: name,
      partnerDisplayName: partnerDisplayName,
      
      // Avatar
      avatarUrl: avatarUrl,
      
      // Computed flags
      canBuy: isCustomer,
      canSell: hasPartnerRole && isApproved
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
