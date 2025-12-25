// src/pages/api/admin/delete-user.ts
// Server-side API to delete user data for admin dashboard
// Uses soft-delete approach (sets deleted flag) since Firestore rules block hard deletes

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

// Helper to initialize Firebase for Cloudflare runtime
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

  // Check admins collection
  const adminDoc = await getDocument('admins', uid);
  if (adminDoc) return true;

  // Check if user has admin role
  const userDoc = await getDocument('users', uid);
  if (userDoc?.isAdmin || userDoc?.roles?.admin) return true;

  return false;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: destructive operations - 3 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-user:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

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
    const { userId } = body;

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing userId'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const results = {
      customers: false,
      users: false,
      artists: false
    };

    const timestamp = new Date().toISOString();
    const softDeleteData = {
      deleted: true,
      deletedAt: timestamp,
      deletedBy: adminUid,
      suspended: true,
      updatedAt: timestamp
    };

    // Soft-delete from customers collection
    try {
      const customerDoc = await getDocument('customers', userId);
      if (customerDoc) {
        await updateDocument('customers', userId, softDeleteData);
        results.customers = true;
      }
    } catch (e) {
      console.log('[delete-user] customers:', e instanceof Error ? e.message : 'error');
    }

    // Soft-delete from users collection
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc) {
        await updateDocument('users', userId, {
          deleted: true,
          deletedAt: timestamp,
          suspended: true,
          updatedAt: timestamp
        });
        results.users = true;
      }
    } catch (e) {
      console.log('[delete-user] users:', e instanceof Error ? e.message : 'error');
    }

    // Soft-delete from artists collection
    try {
      const artistDoc = await getDocument('artists', userId);
      if (artistDoc) {
        await updateDocument('artists', userId, softDeleteData);
        results.artists = true;
      }
    } catch (e) {
      console.log('[delete-user] artists:', e instanceof Error ? e.message : 'error');
    }

    // Check if at least one update succeeded
    const anySuccess = results.customers || results.users || results.artists;

    if (!anySuccess) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found in any collection'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'User deleted successfully',
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin/delete-user] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete user'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
