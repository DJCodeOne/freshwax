// src/pages/api/admin/list-partners.ts
// Server-side endpoint to list partners (artists and merch suppliers)
// Uses firebase-admin to bypass security rules

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// Hardcoded admin UIDs for verification
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33'];
const ADMIN_EMAILS = ['freshwaxonline@gmail.com'];

async function isAdmin(uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;
  
  const db = getFirestore();
  
  // Check admins collection
  const adminDoc = await db.collection('admins').doc(uid).get();
  if (adminDoc.exists) return true;
  
  // Check users collection for admin role
  const userDoc = await db.collection('users').doc(uid).get();
  if (userDoc.exists) {
    const data = userDoc.data();
    if (data?.isAdmin || data?.role === 'admin' || data?.roles?.admin) return true;
    if (data?.email && ADMIN_EMAILS.includes(data.email.toLowerCase())) return true;
  }
  
  // Check artists collection for admin role
  const artistDoc = await db.collection('artists').doc(uid).get();
  if (artistDoc.exists) {
    const data = artistDoc.data();
    if (data?.isAdmin || data?.role === 'admin') return true;
  }
  
  return false;
}

export const GET: APIRoute = async ({ request }) => {
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
    const db = getFirestore();
    const partners: any[] = [];
    const userMap = new Map();
    
    // Helper to get first non-empty value
    const firstNonEmpty = (...values: any[]) => values.find(v => v && String(v).trim() !== '') || '';
    
    // Load from users collection
    const usersSnap = await db.collection('users').get();
    usersSnap.forEach(doc => {
      const data = doc.data();
      const roles = data.roles || {};
      
      // Only include if they have artist or merch role
      if (roles.artist || roles.merchSupplier) {
        userMap.set(doc.id, {
          id: doc.id,
          email: data.email || '',
          name: data.fullName || data.name || data.displayName || '',
          displayName: data.partnerInfo?.displayName || data.displayName || '',
          phone: data.phone || '',
          address: data.address || null,
          isAdmin: data.isAdmin || data.role === 'admin' || roles.admin || false,
          isCustomer: roles.customer ?? true,
          isArtist: roles.artist || false,
          isDJ: roles.dj || false,
          isMerchSupplier: roles.merchSupplier || false,
          isApproved: data.partnerInfo?.approved || false,
          isDisabled: data.disabled || false,
          canBuy: data.permissions?.canBuy ?? true,
          canComment: data.permissions?.canComment ?? true,
          canRate: data.permissions?.canRate ?? true,
          createdAt: data.createdAt?.toDate?.() || null,
          source: 'users'
        });
      }
    });
    
    // Load from artists collection (legacy)
    const artistsSnap = await db.collection('artists').get();
    artistsSnap.forEach(doc => {
      const data = doc.data();
      
      if (userMap.has(doc.id)) {
        // Merge data
        const existing = userMap.get(doc.id);
        existing.isArtist = true;
        existing.isDJ = existing.isDJ || data.isDJ || false;
        existing.isMerchSupplier = existing.isMerchSupplier || data.isMerchSupplier || false;
        existing.isApproved = existing.isApproved || data.approved || false;
        existing.name = firstNonEmpty(existing.name, data.artistName, data.name);
        existing.displayName = firstNonEmpty(existing.displayName, data.artistName, data.name);
        if (!existing.email && data.email) existing.email = data.email;
        if (!existing.address && data.address) existing.address = data.address;
      } else {
        userMap.set(doc.id, {
          id: doc.id,
          email: data.email || '',
          name: data.artistName || data.name || '',
          displayName: data.artistName || data.name || '',
          phone: data.phone || '',
          address: data.address || null,
          isAdmin: data.isAdmin || data.role === 'admin' || false,
          isCustomer: true,
          isArtist: true,
          isDJ: data.isDJ || false,
          isMerchSupplier: data.isMerchSupplier || false,
          isApproved: data.approved || false,
          isDisabled: data.disabled || false,
          canBuy: true,
          canComment: true,
          canRate: true,
          createdAt: data.createdAt?.toDate?.() || null,
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
