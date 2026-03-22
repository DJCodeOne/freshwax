// src/pages/api/auth/set-session.ts
// Server-side HttpOnly cookie management for auth session
// __session is HttpOnly (contains the Firebase ID token — the actual auth credential).
// userId, customerId, partnerId are NOT HttpOnly (contain only the Firebase UID
// which is not a secret, and are read by client-side JS for state management).

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyUserToken } from '../../../lib/firebase-rest';
import { ApiErrors, successResponse } from '../../../lib/api-utils';

export const prerender = false;

/**
 * POST /api/auth/set-session/
 * Body: { token, action, isPartner? }
 *
 * action = "login"       -> sets __session (HttpOnly) + userId + customerId (+ partnerId if eligible)
 * action = "refresh"     -> refreshes __session token only (HttpOnly)
 * action = "logout"      -> clears all auth cookies
 * action = "set-partner" -> sets partnerId cookie only (requires valid token)
 */
export const POST: APIRoute = async ({ request }) => {
  // Rate limit: auth attempts - 10 per 15 minutes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`auth-set-session:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch (_e: unknown) {
    return ApiErrors.badRequest('Invalid JSON body');
  }

  const action = (body.action as string) || 'login';
  const isSecure = request.url.startsWith('https');

  // --- LOGOUT: clear all auth cookies ---
  if (action === 'logout') {
    const clearCookies = buildClearCookies(isSecure);
    const response = successResponse({} as Record<string, unknown>, 200);
    for (const cookie of clearCookies) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  }

  // All other actions require a valid Firebase ID token
  const token = body.token as string | undefined;
  if (!token || typeof token !== 'string') {
    return ApiErrors.badRequest('Missing or invalid token');
  }

  // Verify the Firebase ID token
  const userId = await verifyUserToken(token);
  if (!userId) {
    return ApiErrors.unauthorized('Invalid or expired token');
  }

  const cookies: string[] = [];

  if (action === 'login' || action === 'refresh') {
    // __session cookie: HttpOnly, 1 hour (Firebase tokens expire hourly)
    cookies.push(buildCookie('__session', token, 3600, isSecure, true));

    if (action === 'login') {
      // userId + customerId cookies: NOT HttpOnly (client JS reads them), 30 days
      const thirtyDays = 30 * 24 * 60 * 60;
      cookies.push(buildCookie('userId', userId, thirtyDays, isSecure, false));
      cookies.push(buildCookie('customerId', userId, thirtyDays, isSecure, false));

      // Check if user has partner role and set partnerId cookie
      if (body.isPartner === true) {
        cookies.push(buildCookie('partnerId', userId, thirtyDays, isSecure, false));
      }
    }
  } else if (action === 'set-partner') {
    // Set partnerId cookie only (NOT HttpOnly — client JS reads it)
    const thirtyDays = 30 * 24 * 60 * 60;
    cookies.push(buildCookie('partnerId', userId, thirtyDays, isSecure, false));
  } else {
    return ApiErrors.badRequest('Invalid action');
  }

  const response = successResponse({ userId } as Record<string, unknown>, 200);
  for (const cookie of cookies) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
};

/**
 * Build a Set-Cookie header value.
 * @param httpOnly - true for __session (auth token), false for userId/customerId/partnerId (UIDs)
 */
function buildCookie(name: string, value: string, maxAge: number, isSecure: boolean, httpOnly: boolean): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (httpOnly) {
    parts.push('HttpOnly');
  }
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Build Set-Cookie headers to clear all auth cookies.
 * __session is cleared as HttpOnly; others as non-HttpOnly.
 */
function buildClearCookies(isSecure: boolean): string[] {
  const httpOnlyCookies = ['__session'];
  const regularCookies = ['userId', 'customerId', 'partnerId'];

  const all = [
    ...httpOnlyCookies.map(name => buildClearCookie(name, isSecure, true)),
    ...regularCookies.map(name => buildClearCookie(name, isSecure, false)),
  ];
  return all;
}

function buildClearCookie(name: string, isSecure: boolean, httpOnly: boolean): string {
  const parts = [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
  ];
  if (httpOnly) {
    parts.push('HttpOnly');
  }
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
