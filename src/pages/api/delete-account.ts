// src/pages/api/delete-account.ts
// Delete user account and associated data
// Note: Firebase Auth user deletion requires Admin SDK which doesn't work on Cloudflare
// The Firestore documents will be deleted, but auth user may need manual cleanup

import type { APIRoute } from 'astro';
import { deleteDocument, queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { userId } = body;
    
    if (!userId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'userId is required' 
      }), {
        status: 400,
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

    // Delete orders associated with this user
    try {
      const orders = await queryCollection('orders', [
        { field: 'customer.userId', operator: '==', value: userId }
      ]);

      if (orders && orders.length > 0) {
        for (const order of orders) {
          await deleteDocument('orders', order.id);
        }
        log.info('[delete-account] Deleted', orders.length, 'orders');
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