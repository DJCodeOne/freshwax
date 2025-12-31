// src/pages/api/admin/list-partners.ts
// Server-side endpoint to list partners (artists and merch suppliers)
// Uses firebase-rest.ts for Firestore access

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Hardcoded admin UIDs for verification
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];
const ADMIN_EMAILS = ['freshwaxonline@gmail.com', 'davidhagon@gmail.com'];

async function isAdmin(uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;

  // Check admins collection
  const adminDoc = await getDocument('admins', uid);
  if (adminDoc) return true;

  // Check users collection for admin role
  const userDoc = await getDocument('users', uid);
  if (userDoc) {
    if (userDoc.isAdmin || userDoc.role === 'admin' || userDoc.roles?.admin) return true;
    if (userDoc.email && ADMIN_EMAILS.includes(userDoc.email.toLowerCase())) return true;
  }

  // Check artists collection for admin role
  const artistDoc = await getDocument('artists', uid);
  if (artistDoc) {
    if (artistDoc.isAdmin || artistDoc.role === 'admin') return true;
  }

  return false;
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');
  
  if (!uid) {
    return new Response(JSON.stringify({ success: false, error: 'Missing uid' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Verify admin status
  const adminCheck = await isAdmin(uid);
  if (!adminCheck) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const partners: any[] = [];

    // Load from users collection - SOURCE OF TRUTH
    const users = await queryCollection('users', {
      cacheTime: 300000,  // 5 min cache
      limit: 500
    });

    // Process users - only include those with artist or merch roles
    for (const user of users) {
      if (user.deleted === true) continue;

      const roles = user.roles || {};
      const isArtist = roles.artist === true;
      const isMerchSupplier = roles.merchSupplier === true || roles.merchSeller === true;

      // Only include if they have artist or merch role
      if (!isArtist && !isMerchSupplier) continue;

      partners.push({
        id: user.id,
        email: user.email || '',
        name: user.fullName || user.name || user.displayName || '',
        displayName: user.partnerInfo?.displayName || user.displayName || '',
        phone: user.phone || '',
        address: user.address || null,
        isAdmin: user.isAdmin || roles.admin || false,
        isCustomer: roles.customer !== false,
        isArtist: isArtist,
        isDJ: roles.dj !== false,
        isMerchSupplier: isMerchSupplier,
        isApproved: user.approved === true ||
                    user.partnerInfo?.approved === true ||
                    user.pendingRoles?.artist?.status === 'approved' ||
                    user.pendingRoles?.merchSeller?.status === 'approved',
        isDisabled: user.disabled === true || user.suspended === true,
        canBuy: user.permissions?.canBuy ?? true,
        canComment: user.permissions?.canComment ?? true,
        canRate: user.permissions?.canRate ?? true,
        createdAt: user.createdAt || user.registeredAt || null,
        source: 'users'
      });
    }

    // Sort by name
    partners.sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || ''));

    return new Response(JSON.stringify({
      success: true,
      partners,
      stats: {
        total: partners.length,
        artists: partners.filter(p => p.isArtist).length,
        merch: partners.filter(p => p.isMerchSupplier).length,
        pending: partners.filter(p => !p.isApproved).length,
        approved: partners.filter(p => p.isApproved).length
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[list-partners] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch partners',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
