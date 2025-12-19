// src/pages/api/admin/update-user.ts
// Server-side API to update user data for admin dashboard
// Uses Firebase REST API to bypass Firestore rules

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase for Cloudflare runtime
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

// Hardcoded admin UIDs for verification
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];

async function isAdmin(uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;

  // Check admins collection
  const adminDoc = await getDocument('admins', uid);
  if (adminDoc) return true;

  // Check if user has admin role
  const userDoc = await getDocument('users', uid);
  if (userDoc?.isAdmin || userDoc?.roles?.admin) return true;

  return false;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    // Get admin UID from header
    const adminUid = request.headers.get('x-admin-uid');

    if (!adminUid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Admin UID required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify admin status
    const authorized = await isAdmin(adminUid);
    if (!authorized) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized - admin access required'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Parse request body
    const body = await request.json();
    const { userId, sourceCollection, updates } = body;

    if (!userId || !updates) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing userId or updates'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const timestamp = new Date().toISOString();
    const results = {
      customers: false,
      users: false,
      artists: false
    };

    // Update customers collection
    try {
      const customerDoc = await getDocument('customers', userId);
      if (customerDoc) {
        await updateDocument('customers', userId, {
          displayName: updates.displayName,
          name: updates.fullName || updates.displayName,
          fullName: updates.fullName,
          email: updates.email,
          phone: updates.phone,
          address: updates.address,
          isDJ: updates.roles?.dj ?? true,
          isArtist: updates.roles?.artist ?? false,
          isMerchSupplier: updates.roles?.merchSupplier ?? false,
          isAdmin: updates.isAdmin ?? false,
          roles: updates.roles,
          permissions: updates.permissions,
          approved: updates.approved,
          suspended: updates.suspended,
          adminNotes: updates.adminNotes || '',
          updatedAt: timestamp
        });
        results.customers = true;
      } else {
        // Create customer doc if doesn't exist
        await setDocument('customers', userId, {
          displayName: updates.displayName,
          name: updates.fullName || updates.displayName,
          fullName: updates.fullName,
          email: updates.email,
          phone: updates.phone,
          address: updates.address,
          isDJ: updates.roles?.dj ?? true,
          isArtist: updates.roles?.artist ?? false,
          isMerchSupplier: updates.roles?.merchSupplier ?? false,
          isAdmin: updates.isAdmin ?? false,
          roles: updates.roles,
          permissions: updates.permissions,
          approved: updates.approved,
          suspended: updates.suspended,
          adminNotes: updates.adminNotes || '',
          createdAt: timestamp,
          updatedAt: timestamp
        });
        results.customers = true;
      }
    } catch (e) {
      console.error('[update-user] Error updating customers:', e);
    }

    // Update users collection
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc) {
        await updateDocument('users', userId, {
          displayName: updates.displayName,
          approved: updates.approved,
          isAdmin: updates.isAdmin ?? false,
          roles: updates.roles,
          permissions: updates.permissions,
          updatedAt: timestamp
        });
        results.users = true;
      }
    } catch (e) {
      console.error('[update-user] Error updating users:', e);
    }

    // Update artists collection if user has artist/merch role OR source is artists
    const shouldUpdateArtists = updates.roles?.artist || updates.roles?.merchSupplier || sourceCollection === 'artists';
    if (shouldUpdateArtists) {
      try {
        const artistDoc = await getDocument('artists', userId);
        if (artistDoc) {
          await updateDocument('artists', userId, {
            artistName: updates.displayName,
            displayName: updates.displayName,
            name: updates.fullName || updates.displayName,
            email: updates.email,
            phone: updates.phone,
            isArtist: updates.roles?.artist ?? false,
            isMerchSupplier: updates.roles?.merchSupplier ?? false,
            approved: updates.approved,
            suspended: updates.suspended,
            adminNotes: updates.adminNotes || '',
            updatedAt: timestamp
          });
          results.artists = true;
        } else if (updates.roles?.artist || updates.roles?.merchSupplier) {
          // Create artist doc if user has artist/merch roles
          await setDocument('artists', userId, {
            artistName: updates.displayName,
            displayName: updates.displayName,
            name: updates.fullName || updates.displayName,
            email: updates.email,
            phone: updates.phone,
            isArtist: updates.roles?.artist ?? false,
            isMerchSupplier: updates.roles?.merchSupplier ?? false,
            approved: updates.approved,
            suspended: updates.suspended,
            adminNotes: updates.adminNotes || '',
            userId: userId,
            registeredAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp
          });
          results.artists = true;
        }
      } catch (e) {
        console.error('[update-user] Error updating artists:', e);
      }
    }

    // Check if at least one update succeeded
    const anySuccess = results.customers || results.users || results.artists;

    if (!anySuccess) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update any collections'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'User updated successfully',
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin/update-user] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update user'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
