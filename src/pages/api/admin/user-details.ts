// src/pages/api/admin/user-details.ts
// Get detailed user information for admin panel

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/user-details');

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = locals.runtime.env;
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
      return ApiErrors.badRequest('User ID required');
    }

    // Get user from users collection
    const user = await getDocument('users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    // Return user data (sanitized)
    return successResponse({ user: {
        id: userId,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        createdAt: user.createdAt,
        subscription: user.subscription,
        roles: user.roles,
        usage: user.usage
      } });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to fetch user details');
  }
};
