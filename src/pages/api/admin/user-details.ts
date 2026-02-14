// src/pages/api/admin/user-details.ts
// Get detailed user information for admin panel

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`user-details:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // SECURITY: Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get user from users collection
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Return user data (sanitized)
    return new Response(JSON.stringify({
      success: true,
      user: {
        id: userId,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        createdAt: user.createdAt,
        subscription: user.subscription,
        roles: user.roles,
        usage: user.usage
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[user-details] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch user details'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
