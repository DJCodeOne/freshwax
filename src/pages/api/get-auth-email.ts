// src/pages/api/get-auth-email.ts
// Returns user email from Firebase Auth
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');
  
  if (!uid) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Missing uid' 
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(uid);
    
    return new Response(JSON.stringify({
      success: true,
      uid: userRecord.uid,
      email: userRecord.email || '',
      displayName: userRecord.displayName || '',
      photoURL: userRecord.photoURL || '',
      emailVerified: userRecord.emailVerified,
      disabled: userRecord.disabled,
      creationTime: userRecord.metadata.creationTime,
      lastSignInTime: userRecord.metadata.lastSignInTime
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    console.error('[get-auth-email] Error:', error.message);
    
    if (error.code === 'auth/user-not-found') {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found in Firebase Auth'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
