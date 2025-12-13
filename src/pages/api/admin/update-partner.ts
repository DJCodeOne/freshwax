// src/pages/api/admin/update-partner.ts
// Server-side endpoint to update partner permissions
// Uses firebase-rest.ts for Firestore access

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Hardcoded admin UIDs for verification
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33'];
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

  return false;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

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
    
    const now = new Date().toISOString();
    const updates: string[] = [];

    // Check which collections have this partner
    const [userDoc, artistDoc] = await Promise.all([
      getDocument('users', partnerId),
      getDocument('artists', partnerId)
    ]);

    console.log('[update-partner] Docs exist - users:', !!userDoc, 'artists:', !!artistDoc);

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

    if (userDoc) {
      await updateDocument('users', partnerId, userUpdate);
      updates.push('users:updated');
    } else {
      // Create user doc if it doesn't exist
      await setDocument('users', partnerId, {
        ...userUpdate,
        email: artistDoc?.email || '',
        fullName: artistDoc?.artistName || artistDoc?.name || '',
        createdAt: now
      });
      updates.push('users:created');
    }

    // Update artists collection
    if (artistDoc) {
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
      await updateDocument('artists', partnerId, artistUpdate);
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
