// src/pages/api/admin/lobby-bypass.ts
// Admin API for managing DJ lobby access bypass
// Allows admins to grant/revoke access to DJs who don't meet the 10 likes requirement
// NOTE: getUserByEmail functionality replaced with Firestore lookup (Firebase Admin doesn't work on Cloudflare)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, deleteDocument } from '../../../lib/firebase-rest';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const lobbyBypassSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  email: z.string().email().max(320).optional(),
  userId: z.string().max(200).optional(),
  reason: z.string().max(1000).optional(),
  adminKey: z.string().max(500).optional(),
  idToken: z.string().max(5000).optional(),
}).strip();

const log = createLogger('[lobby-bypass]');

export const prerender = false;

// Helper to get admin key from environment
function getAdminKey(locals: App.Locals): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}



// GET: List all bypass approvals
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`lobby-bypass:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);



  // SECURITY: Require admin authentication for listing bypasses
  const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action !== 'list') {
    return ApiErrors.badRequest('Invalid action');
  }

  try {
    const snapshot = await queryCollection('djLobbyBypass', {
      orderBy: { field: 'grantedAt', direction: 'DESCENDING' },
      skipCache: true
    });

    const bypasses = snapshot.map((doc: Record<string, unknown>) => ({
      id: doc.id,
      userId: doc.id,
      ...doc,
      grantedAt: doc.grantedAt instanceof Date ? doc.grantedAt.toISOString() : doc.grantedAt
    }));

    return successResponse({ bypasses });
  } catch (error: unknown) {
    log.error('[lobby-bypass] Error listing:', error);
    return ApiErrors.serverError('Internal error');
  }
};

// POST: Grant or revoke bypass
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`lobby-bypass-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);


  const saQuery = getSaQuery(locals);
  try {
    const data = await request.json();

    const parsed = lobbyBypassSchema.safeParse(data);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request: action (grant|revoke) is required');
    }

    const { action, email, userId, reason } = parsed.data;

    // Admin auth check (timing-safe comparison)
    const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
    const adminEnv = locals?.runtime?.env;
    initAdminEnv({ ADMIN_UIDS: adminEnv?.ADMIN_UIDS, ADMIN_EMAILS: adminEnv?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, data);
    if (authError) return authError;

    if (action === 'grant') {
      if (!email) {
        return ApiErrors.badRequest('Email required');
      }

      // Find user by email in Firestore (Firebase Auth Admin SDK doesn't work on Cloudflare)
      let targetUserId: string | null = null;
      let userName: string | null = null;

      // Search all user collections in parallel for efficiency
      const [users, customers, artists] = await Promise.all([
        saQuery('users', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        }),
        saQuery('customers', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        }),
        saQuery('artists', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        })
      ]);

      if (users.length > 0) {
        targetUserId = users[0].id;
        userName = users[0].displayName || users[0].name || null;
      } else if (customers.length > 0) {
        targetUserId = customers[0].id;
        userName = customers[0].displayName || customers[0].firstName || null;
      } else if (artists.length > 0) {
        targetUserId = artists[0].id;
        userName = artists[0].displayName || artists[0].artistName || artists[0].name || null;
      }

      if (!targetUserId) {
        return ApiErrors.notFound('User not found with that email. They need to create an account first.');
      }

      // Grant bypass - write to djLobbyBypass collection
      await setDocument('djLobbyBypass', targetUserId, {
        email,
        name: userName,
        reason: reason || null,
        grantedAt: new Date(),
        grantedBy: 'admin'
      });

      // Set user's bypass flag - try update first, then create if doesn't exist
      const userUpdateData = {
        'go-liveBypassed': true,
        bypassedAt: new Date().toISOString(),
        bypassedBy: 'admin'
      };

      try {
        // Try to update existing user document
        await updateDocument('users', targetUserId, userUpdateData);
      } catch (updateError: unknown) {
        // If update fails (doc doesn't exist or permission), try to create
        try {
          await setDocument('users', targetUserId, userUpdateData);
        } catch (createError: unknown) {
          // Log but don't fail - the djLobbyBypass entry was created successfully
          log.warn(`[lobby-bypass] Could not set user bypass flag: ${createError instanceof Error ? createError.message : String(createError)}`);
        }
      }

      log.info(`[lobby-bypass] Granted bypass to ${email} (${targetUserId})`);

      return successResponse({ message: `Lobby access granted to ${email}`,
        userId: targetUserId });

    } else if (action === 'revoke') {
      if (!userId) {
        return ApiErrors.badRequest('User ID required');
      }

      // Revoke bypass from collection
      await deleteDocument('djLobbyBypass', userId);

      // Also remove bypass flag from user document
      try {
        await updateDocument('users', userId, {
          'go-liveBypassed': false,
          bypassRevokedAt: new Date().toISOString()
        });
      } catch (e: unknown) {
        // User doc might not exist, that's ok
      }

      log.info(`[lobby-bypass] Revoked bypass for ${userId}`);

      return successResponse({ message: 'Bypass revoked' });

    } else {
      return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    log.error('[lobby-bypass] Error:', error);
    return ApiErrors.serverError('Internal error');
  }
};
