// src/pages/api/admin/update-partner.ts
// Server-side API to update partner data for admin dashboard
// Uses Firebase REST API - only updates fields allowed by Firestore rules

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

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

async function isAdmin(uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;
  const adminDoc = await getDocument('admins', uid);
  if (adminDoc) return true;
  const userDoc = await getDocument('users', uid);
  if (userDoc?.isAdmin || userDoc?.roles?.admin) return true;
  return false;
}

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const body = await request.json();
    const { adminUid, partnerId, updates } = body;

    console.log('[update-partner] Request:', { adminUid, partnerId, updates });

    if (!adminUid || !partnerId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing adminUid or partnerId'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify admin status
    const authorized = await isAdmin(adminUid);
    if (!authorized) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();
    const results: string[] = [];

    // Get current docs
    const [userDoc, artistDoc] = await Promise.all([
      getDocument('users', partnerId),
      getDocument('artists', partnerId)
    ]);

    console.log('[update-partner] Found docs - users:', !!userDoc, 'artists:', !!artistDoc);

    // Update artists collection - this is the main partner data store
    // Allowed fields: isArtist, isMerchSupplier, revokedAt, revokedBy, updatedAt,
    //                 artistName, name, displayName, email, phone, approved, suspended, adminNotes
    if (artistDoc) {
      const artistUpdate: any = {
        updatedAt: now
      };

      // Basic info
      if (updates.name !== undefined) {
        artistUpdate.artistName = updates.name;
        artistUpdate.name = updates.name;
        artistUpdate.displayName = updates.name;
      }
      if (updates.email !== undefined) artistUpdate.email = updates.email;
      if (updates.phone !== undefined) artistUpdate.phone = updates.phone;
      if (updates.adminNotes !== undefined) artistUpdate.adminNotes = updates.adminNotes;

      // Roles
      if (updates.isArtist !== undefined) artistUpdate.isArtist = updates.isArtist;
      if (updates.isMerchSupplier !== undefined) artistUpdate.isMerchSupplier = updates.isMerchSupplier;

      // Status
      if (updates.approved !== undefined) artistUpdate.approved = updates.approved;
      if (updates.suspended !== undefined) artistUpdate.suspended = updates.suspended;

      try {
        await updateDocument('artists', partnerId, artistUpdate);
        results.push('artists:updated');
        console.log('[update-partner] Updated artists:', artistUpdate);
      } catch (e) {
        console.error('[update-partner] artists update failed:', e);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to update partner: ' + (e instanceof Error ? e.message : 'Unknown error')
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Update users collection if it exists
    // Allowed fields: roles, pendingRoles, displayName, approved, updatedAt
    if (userDoc) {
      const userUpdate: any = {
        updatedAt: now
      };

      if (updates.name !== undefined) userUpdate.displayName = updates.name;
      if (updates.approved !== undefined) userUpdate.approved = updates.approved;

      // Build roles object
      if (updates.isArtist !== undefined || updates.isMerchSupplier !== undefined) {
        userUpdate.roles = {
          customer: true,
          dj: true,
          artist: updates.isArtist ?? userDoc.roles?.artist ?? false,
          merchSupplier: updates.isMerchSupplier ?? userDoc.roles?.merchSupplier ?? false,
          admin: updates.isAdmin ?? userDoc.roles?.admin ?? false
        };
      }

      try {
        await updateDocument('users', partnerId, userUpdate);
        results.push('users:updated');
        console.log('[update-partner] Updated users:', userUpdate);
      } catch (e) {
        console.warn('[update-partner] users update failed (non-critical):', e instanceof Error ? e.message : e);
      }
    }

    // Update or create customers collection record
    // This ensures downgraded partners appear in User Management
    try {
      const customerDoc = await getDocument('customers', partnerId);
      const isBeingDowngraded = updates.isArtist === false && updates.isMerchSupplier === false;

      if (customerDoc) {
        // Update existing customer record
        const customerUpdate: any = {
          updatedAt: now
        };

        if (updates.isArtist !== undefined) customerUpdate.isArtist = updates.isArtist;
        if (updates.isMerchSupplier !== undefined) customerUpdate.isMerchSupplier = updates.isMerchSupplier;
        if (updates.approved !== undefined) customerUpdate.approved = updates.approved;

        customerUpdate.roles = {
          customer: true,
          dj: true,
          artist: updates.isArtist ?? customerDoc.roles?.artist ?? false,
          merch: updates.isMerchSupplier ?? customerDoc.roles?.merch ?? false
        };

        await updateDocument('customers', partnerId, customerUpdate);
        results.push('customers:updated');
      } else if (isBeingDowngraded && artistDoc) {
        // Create customers record for downgraded partner so they appear in User Management
        const { setDocument } = await import('../../../lib/firebase-rest');
        await setDocument('customers', partnerId, {
          uid: partnerId,
          displayName: updates.name || artistDoc.artistName || artistDoc.name || '',
          name: updates.name || artistDoc.artistName || artistDoc.name || '',
          email: updates.email || artistDoc.email || '',
          phone: updates.phone || artistDoc.phone || '',
          isDJ: true,
          isArtist: false,
          isMerchSupplier: false,
          roles: {
            customer: true,
            dj: true,
            artist: false,
            merch: false
          },
          approved: true,
          createdAt: artistDoc.createdAt || now,
          updatedAt: now
        });
        results.push('customers:created');
        console.log('[update-partner] Created customers record for downgraded partner');
      }
    } catch (e) {
      console.warn('[update-partner] customers update failed:', e instanceof Error ? e.message : e);
    }

    console.log('[update-partner] Completed:', results);

    return new Response(JSON.stringify({
      success: true,
      message: 'Partner updated successfully',
      results
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[update-partner] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update partner'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
