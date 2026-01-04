// src/pages/api/admin/delete-user.ts
// Server-side API to delete user data for admin dashboard
// Uses soft-delete approach (sets deleted flag) since Firestore rules block hard deletes

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv, invalidateUsersCache } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

// Helper to initialize Firebase for Cloudflare runtime
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: admin delete operations - 20 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-user:${clientId}`, RateLimiters.adminDelete);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    // Parse request body
    const body = await request.json();
    const { userId } = body;

    // SECURITY: Require admin authentication via admin key (not spoofable UID)
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

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
      deletedBy: 'admin', // Admin key auth doesn't provide UID
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

    // Invalidate users cache so the list refreshes immediately
    invalidateUsersCache();

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
