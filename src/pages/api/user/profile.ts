// src/pages/api/user/profile.ts
// Get user profile data including approved relay info
// SECURITY: Requires authentication - user can only view their own profile
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('user/profile');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`user-profile:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // SECURITY: Verify the requesting user's identity
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    // User can only fetch their own profile

    // Fetch user data
    const userData = await getDocument('users', userId);

    if (!userData) {
      return new Response(JSON.stringify({
        success: true,
        user: null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Return relevant user data (excluding sensitive fields)
    return new Response(JSON.stringify({
      success: true,
      user: {
        displayName: userData.displayName || userData.name,
        email: userData.email,
        subscription: userData.subscription,
        approvedRelay: userData.approvedRelay || null,
        bypassedAt: userData.bypassedAt,
        'go-liveBypassed': userData['go-liveBypassed']
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to fetch user profile');
  }
};
