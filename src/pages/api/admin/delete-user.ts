// src/pages/api/admin/delete-user.ts
// Server-side API to delete user data for admin dashboard
// Uses soft-delete approach (sets deleted flag) since Firestore rules block hard deletes

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, invalidateUsersCache } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, createLogger } from '../../../lib/api-utils';
const log = createLogger('[delete-user]');

const deleteUserSchema = z.object({
  userId: z.string().min(1),
  adminKey: z.string().optional(),
});

export const prerender = false;



export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: admin delete operations - 20 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-user:${clientId}`, RateLimiters.adminDelete);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Parse request body
    const body = await request.json();

    // SECURITY: Require admin authentication via admin key (not spoofable UID)
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = deleteUserSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { userId } = parsed.data;

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
      const customerDoc = await getDocument('users', userId);
      if (customerDoc) {
        await updateDocument('users', userId, softDeleteData);
        results.customers = true;
      }
    } catch (e) {
      log.info('[delete-user] customers:', e instanceof Error ? e.message : 'error');
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
      log.info('[delete-user] users:', e instanceof Error ? e.message : 'error');
    }

    // Soft-delete from artists collection
    try {
      const artistDoc = await getDocument('artists', userId);
      if (artistDoc) {
        await updateDocument('artists', userId, softDeleteData);
        results.artists = true;
      }
    } catch (e) {
      log.info('[delete-user] artists:', e instanceof Error ? e.message : 'error');
    }

    // Check if at least one update succeeded
    const anySuccess = results.customers || results.users || results.artists;

    if (!anySuccess) {
      return ApiErrors.notFound('User not found in any collection');
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

  } catch (error: unknown) {
    log.error('[admin/delete-user] Error:', error);
    return ApiErrors.serverError('Failed to delete user');
  }
};
