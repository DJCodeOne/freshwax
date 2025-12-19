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

    // Update customers collection - only include provided fields
    try {
      const customerDoc = await getDocument('customers', userId);
      if (customerDoc) {
        const customerUpdate: any = { updatedAt: timestamp };

        if (updates.displayName !== undefined) {
          customerUpdate.displayName = updates.displayName;
          customerUpdate.name = updates.fullName || updates.displayName;
        }
        if (updates.fullName !== undefined) customerUpdate.fullName = updates.fullName;
        if (updates.email !== undefined) customerUpdate.email = updates.email;
        if (updates.phone !== undefined) customerUpdate.phone = updates.phone;
        if (updates.address !== undefined) customerUpdate.address = updates.address;
        if (updates.roles !== undefined) {
          customerUpdate.roles = updates.roles;
          customerUpdate.isDJ = updates.roles.dj ?? true;
          customerUpdate.isArtist = updates.roles.artist ?? false;
          customerUpdate.isMerchSupplier = updates.roles.merchSupplier ?? false;
        }
        if (updates.isAdmin !== undefined) customerUpdate.isAdmin = updates.isAdmin;
        if (updates.permissions !== undefined) customerUpdate.permissions = updates.permissions;
        if (updates.approved !== undefined) customerUpdate.approved = updates.approved;
        if (updates.suspended !== undefined) customerUpdate.suspended = updates.suspended;
        if (updates.adminNotes !== undefined) customerUpdate.adminNotes = updates.adminNotes;

        await updateDocument('customers', userId, customerUpdate);
        results.customers = true;
      }
    } catch (e) {
      console.error('[update-user] Error updating customers:', e);
    }

    // Update users collection - only include provided fields
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc) {
        const userUpdate: any = { updatedAt: timestamp };

        if (updates.displayName !== undefined) userUpdate.displayName = updates.displayName;
        if (updates.approved !== undefined) userUpdate.approved = updates.approved;
        if (updates.isAdmin !== undefined) userUpdate.isAdmin = updates.isAdmin;
        if (updates.roles !== undefined) userUpdate.roles = updates.roles;
        if (updates.permissions !== undefined) userUpdate.permissions = updates.permissions;

        await updateDocument('users', userId, userUpdate);
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
          // Only include fields that are explicitly provided
          const artistUpdate: any = { updatedAt: timestamp };

          if (updates.displayName !== undefined) {
            artistUpdate.artistName = updates.displayName;
            artistUpdate.displayName = updates.displayName;
            artistUpdate.name = updates.fullName || updates.displayName;
          }
          if (updates.email !== undefined) artistUpdate.email = updates.email;
          if (updates.phone !== undefined) artistUpdate.phone = updates.phone;
          if (updates.roles?.artist !== undefined) artistUpdate.isArtist = updates.roles.artist;
          if (updates.roles?.merchSupplier !== undefined) artistUpdate.isMerchSupplier = updates.roles.merchSupplier;
          if (updates.approved !== undefined) artistUpdate.approved = updates.approved;
          if (updates.suspended !== undefined) artistUpdate.suspended = updates.suspended;
          if (updates.adminNotes !== undefined) artistUpdate.adminNotes = updates.adminNotes;

          await updateDocument('artists', userId, artistUpdate);
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
