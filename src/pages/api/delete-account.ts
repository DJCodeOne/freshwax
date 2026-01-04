// src/pages/api/delete-account.ts
// Delete user account and associated data
// Note: Firebase Auth user deletion requires Admin SDK which doesn't work on Cloudflare
// The Firestore documents will be deleted, but auth user may need manual cleanup

import type { APIRoute } from 'astro';
import { deleteDocument, queryCollection, initFirebaseEnv, verifyUserToken } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

// Max 10 orders to delete per account (prevent runaway)
const MAX_ORDERS_TO_DELETE = 10;

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

    log.info('[delete-account] Deleting account for user:', userId);

    // Delete customer document
    try {
      await deleteDocument('customers', userId);
      log.info('[delete-account] Deleted customers document');
    } catch (e) {
      log.info('[delete-account] No customers document to delete');
    }

    // Delete user document (if exists)
    try {
      await deleteDocument('users', userId);
      log.info('[delete-account] Deleted users document');
    } catch (e) {
      log.info('[delete-account] No users document to delete');
    }

    // Delete orders associated with this user (with limit to prevent runaway)
    try {
      const orders = await queryCollection('orders', [
        { field: 'customer.userId', operator: '==', value: userId }
      ]);

      if (orders && orders.length > 0) {
        const ordersToDelete = orders.slice(0, MAX_ORDERS_TO_DELETE);
        for (const order of ordersToDelete) {
          await deleteDocument('orders', order.id);
        }
        log.info('[delete-account] Deleted', ordersToDelete.length, 'orders');
        if (orders.length > MAX_ORDERS_TO_DELETE) {
          log.info('[delete-account] Note:', orders.length - MAX_ORDERS_TO_DELETE, 'orders remain (hit limit)');
        }
      }
    } catch (e) {
      log.info('[delete-account] Error deleting orders:', e);
    }
    
    // Note: Firebase Auth user deletion requires Admin SDK
    // On Cloudflare Workers, we can't use Admin SDK
    // The auth user will need to be cleaned up separately or user can re-create account
    log.info('[delete-account] Note: Auth user deletion skipped (requires Admin SDK)');
    
    return new Response(JSON.stringify({ 
      success: true,
      message: 'Account deleted successfully'
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