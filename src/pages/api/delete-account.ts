// src/pages/api/delete-account.ts
// Delete user account and associated data

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();
const auth = getAuth();

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
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
      await db.collection('customers').doc(userId).delete();
      log.info('[delete-account] Deleted customers document');
    } catch (e) {
      log.info('[delete-account] No customers document to delete');
    }
    
    // Delete user document (if exists)
    try {
      await db.collection('users').doc(userId).delete();
      log.info('[delete-account] Deleted users document');
    } catch (e) {
      log.info('[delete-account] No users document to delete');
    }
    
    // Delete orders associated with this user
    try {
      const ordersSnapshot = await db.collection('orders')
        .where('customer.userId', '==', userId)
        .get();
      
      const batch = db.batch();
      ordersSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      log.info('[delete-account] Deleted', ordersSnapshot.size, 'orders');
    } catch (e) {
      log.info('[delete-account] Error deleting orders:', e);
    }
    
    // Delete Firebase Auth user
    try {
      await auth.deleteUser(userId);
      log.info('[delete-account] Deleted Firebase Auth user');
    } catch (e) {
      log.info('[delete-account] Error deleting auth user:', e);
    }
    
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