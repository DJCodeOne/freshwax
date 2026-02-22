// src/pages/api/admin/check-access.ts
// Check if the current user has admin access
// Replaces client-side Firestore reads to admins/users/artists collections
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/check-access');

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-access:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  try {
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    let isAdmin = false;

    // Check admins collection first
    try {
      const adminDoc = await getDocument('admins', userId);
      if (adminDoc) {
        isAdmin = true;
      }
    } catch (_e: unknown) {
      /* non-critical: admins collection lookup failed, will check users/artists next */
    }

    // Check users collection
    if (!isAdmin) {
      try {
        const userDoc = await getDocument('users', userId);
        if (userDoc) {
          isAdmin = userDoc.isAdmin === true ||
            userDoc.role === 'admin' ||
            userDoc.roles?.admin === true;
        }
      } catch (_e: unknown) {
        /* non-critical: users collection lookup failed, will check artists next */
      }
    }

    // Check artists collection
    if (!isAdmin) {
      try {
        const artistDoc = await getDocument('artists', userId);
        if (artistDoc) {
          isAdmin = artistDoc.isAdmin === true || artistDoc.role === 'admin';
        }
      } catch (_e: unknown) {
        /* non-critical: artists collection lookup failed */
      }
    }

    return successResponse({ isAdmin });
  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to check admin access');
  }
};
