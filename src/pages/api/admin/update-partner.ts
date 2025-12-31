// src/pages/api/admin/update-partner.ts
// Server-side API to update partner data for admin dashboard
// Uses Firebase REST API - only updates fields allowed by Firestore rules

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv, clearCache } from '../../../lib/firebase-rest';

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
    const { adminUid, idToken, partnerId, updates } = body;

    console.log('[update-partner] Request:', { adminUid, partnerId, hasToken: !!idToken, updates });

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
      if (updates.isVinylSeller !== undefined) artistUpdate.isVinylSeller = updates.isVinylSeller;

      // Status
      if (updates.approved !== undefined) artistUpdate.approved = updates.approved;
      if (updates.suspended !== undefined) artistUpdate.suspended = updates.suspended;

      try {
        await updateDocument('artists', partnerId, artistUpdate, idToken);
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

    // Update or create users collection document
    // This is the source of truth for list-partners API
    const userUpdate: any = {
      updatedAt: now
    };

    if (updates.name !== undefined) userUpdate.displayName = updates.name;
    if (updates.approved !== undefined) userUpdate.approved = updates.approved;

    // Build roles object
    userUpdate.roles = {
      customer: true,
      dj: true,
      artist: updates.isArtist ?? userDoc?.roles?.artist ?? artistDoc?.isArtist ?? false,
      merchSupplier: updates.isMerchSupplier ?? userDoc?.roles?.merchSupplier ?? artistDoc?.isMerchSupplier ?? false,
      vinylSeller: updates.isVinylSeller ?? userDoc?.roles?.vinylSeller ?? artistDoc?.isVinylSeller ?? false,
      admin: updates.isAdmin ?? userDoc?.roles?.admin ?? false
    };

    try {
      if (userDoc) {
        // Update existing users document
        await updateDocument('users', partnerId, userUpdate, idToken);
        results.push('users:updated');
        console.log('[update-partner] Updated users:', userUpdate);
      } else {
        // Create users document if it doesn't exist (required for list-partners)
        const { setDocument } = await import('../../../lib/firebase-rest');
        await setDocument('users', partnerId, {
          uid: partnerId,
          email: updates.email || artistDoc?.email || '',
          displayName: updates.name || artistDoc?.artistName || artistDoc?.name || '',
          fullName: updates.name || artistDoc?.artistName || artistDoc?.name || '',
          approved: updates.approved !== false,
          roles: userUpdate.roles,
          createdAt: artistDoc?.createdAt || now,
          updatedAt: now
        }, idToken);
        results.push('users:created');
        console.log('[update-partner] Created users document:', partnerId);
      }
    } catch (e) {
      console.warn('[update-partner] users update failed:', e instanceof Error ? e.message : e);
    }

    // Update or create customers collection record
    // This ensures downgraded partners appear in User Management
    try {
      const customerDoc = await getDocument('customers', partnerId);
      const isBeingDowngraded = updates.isArtist === false && updates.isMerchSupplier === false && updates.isVinylSeller === false;

      if (customerDoc) {
        // Update existing customer record
        const customerUpdate: any = {
          updatedAt: now
        };

        if (updates.isArtist !== undefined) customerUpdate.isArtist = updates.isArtist;
        if (updates.isMerchSupplier !== undefined) customerUpdate.isMerchSupplier = updates.isMerchSupplier;
        if (updates.isVinylSeller !== undefined) customerUpdate.isVinylSeller = updates.isVinylSeller;
        if (updates.approved !== undefined) customerUpdate.approved = updates.approved;

        customerUpdate.roles = {
          customer: true,
          dj: true,
          artist: updates.isArtist ?? customerDoc.roles?.artist ?? false,
          merch: updates.isMerchSupplier ?? customerDoc.roles?.merch ?? false,
          vinylSeller: updates.isVinylSeller ?? customerDoc.roles?.vinylSeller ?? false
        };

        await updateDocument('customers', partnerId, customerUpdate, idToken);
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
          isVinylSeller: false,
          roles: {
            customer: true,
            dj: true,
            artist: false,
            merch: false,
            vinylSeller: false
          },
          approved: true,
          createdAt: artistDoc.createdAt || now,
          updatedAt: now
        }, idToken);
        results.push('customers:created');
        console.log('[update-partner] Created customers record for downgraded partner');
      }
    } catch (e) {
      console.warn('[update-partner] customers update failed:', e instanceof Error ? e.message : e);
    }

    // Update or create vinylSellers collection record
    if (updates.isVinylSeller !== undefined) {
      try {
        const vinylSellerDoc = await getDocument('vinylSellers', partnerId);

        if (updates.isVinylSeller === true && !vinylSellerDoc) {
          // Create vinylSellers record for newly promoted user
          const { setDocument } = await import('../../../lib/firebase-rest');
          await setDocument('vinylSellers', partnerId, {
            id: partnerId,
            userId: partnerId,
            storeName: updates.name || artistDoc?.artistName || 'Vinyl Store',
            description: '',
            location: '',
            discogsUrl: '',
            approved: updates.approved !== false,
            suspended: false,
            ratings: { average: 0, count: 0, breakdown: { communication: 0, accuracy: 0, shipping: 0 } },
            totalSales: 0,
            totalListings: 0,
            createdAt: now,
            updatedAt: now
          }, idToken);
          results.push('vinylSellers:created');
          console.log('[update-partner] Created vinylSellers record for promoted partner');
        } else if (vinylSellerDoc) {
          // Update existing vinylSellers record
          await updateDocument('vinylSellers', partnerId, {
            approved: updates.isVinylSeller && updates.approved !== false,
            suspended: updates.suspended === true || updates.isVinylSeller === false,
            updatedAt: now
          }, idToken);
          results.push('vinylSellers:updated');
        }
      } catch (e) {
        console.warn('[update-partner] vinylSellers update failed:', e instanceof Error ? e.message : e);
      }
    }

    console.log('[update-partner] Completed:', results);

    // Invalidate caches so list-partners sees the update immediately
    clearCache('users');
    clearCache('artists');
    clearCache('query:users');

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
