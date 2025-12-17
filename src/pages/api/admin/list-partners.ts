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
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

// Hardcoded admin UIDs for verification
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];
const ADMIN_EMAILS = ['freshwaxonline@gmail.com'];

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
    const userMap = new Map();

    // Helper to get first non-empty value
    const firstNonEmpty = (...values: any[]) => values.find(v => v && String(v).trim() !== '') || '';

    // Load from users collection
    const users = await queryCollection('users', { skipCache: true });
    users.forEach(user => {
      const roles = user.roles || {};

      // Only include if they have artist or merch role
      if (roles.artist || roles.merchSupplier) {
        userMap.set(user.id, {
          id: user.id,
          email: user.email || '',
          name: user.fullName || user.name || user.displayName || '',
          displayName: user.partnerInfo?.displayName || user.displayName || '',
          phone: user.phone || '',
          address: user.address || null,
          isAdmin: user.isAdmin || user.role === 'admin' || roles.admin || false,
          isCustomer: roles.customer ?? true,
          isArtist: roles.artist || false,
          isDJ: roles.dj || false,
          isMerchSupplier: roles.merchSupplier || false,
          isApproved: user.partnerInfo?.approved || false,
          isDisabled: user.disabled || false,
          canBuy: user.permissions?.canBuy ?? true,
          canComment: user.permissions?.canComment ?? true,
          canRate: user.permissions?.canRate ?? true,
          createdAt: user.createdAt || null,
          source: 'users'
        });
      }
    });

    // Load from artists collection (legacy)
    const artists = await queryCollection('artists', { skipCache: true });
    artists.forEach(artist => {
      if (userMap.has(artist.id)) {
        // Merge data
        const existing = userMap.get(artist.id);
        existing.isArtist = true;
        existing.isDJ = existing.isDJ || artist.isDJ || false;
        existing.isMerchSupplier = existing.isMerchSupplier || artist.isMerchSupplier || false;
        existing.isApproved = existing.isApproved || artist.approved || false;
        existing.name = firstNonEmpty(existing.name, artist.artistName, artist.name);
        existing.displayName = firstNonEmpty(existing.displayName, artist.artistName, artist.name);
        if (!existing.email && artist.email) existing.email = artist.email;
        if (!existing.address && artist.address) existing.address = artist.address;
      } else {
        userMap.set(artist.id, {
          id: artist.id,
          email: artist.email || '',
          name: artist.artistName || artist.name || '',
          displayName: artist.artistName || artist.name || '',
          phone: artist.phone || '',
          address: artist.address || null,
          isAdmin: artist.isAdmin || artist.role === 'admin' || false,
          isCustomer: true,
          isArtist: true,
          isDJ: artist.isDJ || false,
          isMerchSupplier: artist.isMerchSupplier || false,
          isApproved: artist.approved || false,
          isDisabled: artist.disabled || false,
          canBuy: true,
          canComment: true,
          canRate: true,
          createdAt: artist.createdAt || null,
          source: 'artists'
        });
      }
    });

    // Convert map to array
    userMap.forEach(user => partners.push(user));

    // Sort by name
    partners.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

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
