// src/pages/api/admin/check-access.ts
// Check if the current user has admin access
// Replaces client-side Firestore reads to admins/users/artists collections
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-access:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  try {
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let isAdmin = false;

    // Check admins collection first
    try {
      const adminDoc = await getDocument('admins', userId);
      if (adminDoc) {
        isAdmin = true;
      }
    } catch (e) {}

    // Check users collection
    if (!isAdmin) {
      try {
        const userDoc = await getDocument('users', userId);
        if (userDoc) {
          isAdmin = userDoc.isAdmin === true ||
            userDoc.role === 'admin' ||
            userDoc.roles?.admin === true;
        }
      } catch (e) {}
    }

    // Check artists collection
    if (!isAdmin) {
      try {
        const artistDoc = await getDocument('artists', userId);
        if (artistDoc) {
          isAdmin = artistDoc.isAdmin === true || artistDoc.role === 'admin';
        }
      } catch (e) {}
    }

    return new Response(JSON.stringify({
      success: true,
      isAdmin
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('[admin/check-access] Error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to check admin access'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
