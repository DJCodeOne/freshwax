// src/pages/api/delete-account.ts
// Soft delete user account - marks as deleted but keeps data for potential recovery
// User can contact support to restore or permanently delete

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv, verifyUserToken } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);

  // Rate limit: destructive operation - 3 per hour
  const rateCheck = checkRateLimit(`delete-account:${clientId}`, RateLimiters.destructive);
  if (!rateCheck.allowed) {
    log.error(`[delete-account] Rate limit exceeded for ${clientId}`);
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { userId, idToken } = body;

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'userId is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SECURITY: Verify the user is deleting their OWN account via Firebase ID token
    if (!idToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only delete your own account'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[delete-account] Soft deleting account for user:', userId);

    const timestamp = new Date().toISOString();
    const softDeleteData = {
      deleted: true,
      deletedAt: timestamp,
      deletedBy: 'user', // User requested deletion
      suspended: true,
      updatedAt: timestamp
    };

    let anyUpdated = false;

    // Soft delete customer document
    try {
      const customerDoc = await getDocument('customers', userId);
      if (customerDoc) {
        await updateDocument('customers', userId, softDeleteData);
        log.info('[delete-account] Soft deleted customers document');
        anyUpdated = true;
      }
    } catch (e) {
      log.info('[delete-account] No customers document to update');
    }

    // Soft delete user document
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc) {
        await updateDocument('users', userId, softDeleteData);
        log.info('[delete-account] Soft deleted users document');
        anyUpdated = true;
      }
    } catch (e) {
      log.info('[delete-account] No users document to update');
    }

    // Soft delete artist document if exists
    try {
      const artistDoc = await getDocument('artists', userId);
      if (artistDoc) {
        await updateDocument('artists', userId, softDeleteData);
        log.info('[delete-account] Soft deleted artists document');
        anyUpdated = true;
      }
    } catch (e) {
      log.info('[delete-account] No artists document to update');
    }

    if (!anyUpdated) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Account not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Note: Firebase Auth remains active but user won't be able to access anything
    // due to suspended flag. Admin can restore or permanently delete later.

    return new Response(JSON.stringify({
      success: true,
      message: 'Account deleted successfully. Contact support if you need to restore it.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[delete-account] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete account'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};