// src/pages/api/admin/update-partner.ts
// Server-side endpoint to update partner permissions
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
  
  return false;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { adminUid, partnerId, permissions } = body;
    
    console.log('[update-partner] Request received:', { adminUid, partnerId });
    
    if (!adminUid || !partnerId || !permissions) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Missing required fields: adminUid, partnerId, permissions' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Verify admin status
    const adminCheck = await isAdmin(adminUid);
    if (!adminCheck) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const db = getFirestore();
    const now = new Date().toISOString();
    const updates: string[] = [];
    
    // Check which collections have this partner
    const userRef = db.collection('users').doc(partnerId);
    const artistRef = db.collection('artists').doc(partnerId);
    
    const [userDoc, artistDoc] = await Promise.all([
      userRef.get(),
      artistRef.get()
    ]);
    
    console.log('[update-partner] Docs exist - users:', userDoc.exists, 'artists:', artistDoc.exists);
    
    // Update users collection
    const userUpdate: any = {
      phone: permissions.phone || '',
      address: {
        line1: permissions.address?.line1 || '',
        line2: permissions.address?.line2 || '',
        city: permissions.address?.city || '',
        postcode: permissions.address?.postcode || '',
        country: permissions.address?.country || 'United Kingdom'
      },
      disabled: permissions.disabled || false,
      isAdmin: permissions.isAdmin || false,
      roles: {
        customer: permissions.roles?.customer || false,
        artist: permissions.roles?.artist || false,
        dj: permissions.roles?.dj || false,
        merchSupplier: permissions.roles?.merchSupplier || false,
        admin: permissions.isAdmin || false
      },
      partnerInfo: {
        approved: permissions.partnerInfo?.approved || false
      },
      permissions: {
        canBuy: permissions.permissions?.canBuy ?? true,
        canComment: permissions.permissions?.canComment ?? true,
        canRate: permissions.permissions?.canRate ?? true
      },
      updatedAt: now
    };
    
    if (userDoc.exists) {
      await userRef.update(userUpdate);
      updates.push('users:updated');
    } else {
      // Create user doc if it doesn't exist
      const existingArtistData = artistDoc.exists ? artistDoc.data() : {};
      await userRef.set({
        ...userUpdate,
        email: existingArtistData?.email || '',
        fullName: existingArtistData?.artistName || existingArtistData?.name || '',
        createdAt: now
      });
      updates.push('users:created');
    }
    
    // Update artists collection
    if (artistDoc.exists) {
      const artistUpdate = {
        phone: permissions.phone || '',
        address: {
          line1: permissions.address?.line1 || '',
          line2: permissions.address?.line2 || '',
          city: permissions.address?.city || '',
          postcode: permissions.address?.postcode || '',
          country: permissions.address?.country || 'United Kingdom'
        },
        isAdmin: permissions.isAdmin || false,
        isDJ: permissions.roles?.dj || false,
        isMerchSupplier: permissions.roles?.merchSupplier || false,
        approved: permissions.partnerInfo?.approved || false,
        disabled: permissions.disabled || false,
        updatedAt: now
      };
      await artistRef.update(artistUpdate);
      updates.push('artists:updated');
      console.log('[update-partner] Updated artists with:', artistUpdate);
    }
    
    console.log('[update-partner] Updates completed:', updates);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Partner updated successfully',
      updates,
      savedData: {
        disabled: permissions.disabled || false,
        isAdmin: permissions.isAdmin || false,
        isArtist: permissions.roles?.artist || false,
        isDJ: permissions.roles?.dj || false,
        isMerchSupplier: permissions.roles?.merchSupplier || false,
        isApproved: permissions.partnerInfo?.approved || false
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[update-partner] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update partner',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
