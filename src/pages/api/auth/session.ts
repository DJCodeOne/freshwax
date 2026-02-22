// src/pages/api/auth/session.ts
// Verify user session via Firebase ID token
// Accepts Authorization: Bearer <idToken> header

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, getDocument } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger, jsonResponse, successResponse } from '../../../lib/api-utils';

const log = createLogger('auth/session');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  // Rate limit: auth attempts - 10 per 15 minutes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`auth-session:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify the Firebase ID token from Authorization header
    const { userId, error } = await verifyRequestUser(request);

    if (error || !userId) {
      return jsonResponse({
        success: false,
        authenticated: false,
        message: error || 'No valid session'
      }, 200, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Fetch user profile from Firestore
    const userDoc = await getDocument('users', userId);

    return successResponse({
      authenticated: true,
      userId,
      user: userDoc ? {
        displayName: userDoc.displayName || null,
        email: userDoc.email || null,
        role: userDoc.role || 'user',
        isArtist: userDoc.isArtist || false,
        isPro: userDoc.isPro || false,
      } : null
    }, 200, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error: unknown) {
    log.error('[auth/session] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Session verification failed');
  }
};
