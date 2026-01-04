// src/pages/api/get-auth-email.ts
// Returns user email from Firebase Auth - ADMIN ONLY or own user data
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getAdminUids } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

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

export const GET: APIRoute = async ({ request, cookies }) => {
  // Rate limit to prevent enumeration attacks
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-auth-email:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

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

  // Check if requester is authenticated - get from cookies
  const adminId = cookies.get('adminId')?.value;
  const firebaseUid = cookies.get('firebaseUid')?.value;
  const customerId = cookies.get('customerId')?.value;
  const authenticatedUid = adminId || firebaseUid || customerId;

  // Security: Only allow fetching own data, or admin fetching any data
  const adminUids = getAdminUids();
  const isAdmin = adminId ? adminUids.includes(adminId) :
                  firebaseUid ? adminUids.includes(firebaseUid) : false;
  const isOwnData = authenticatedUid === uid;

  if (!isAdmin && !isOwnData) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Unauthorized - can only access your own data'
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(uid);

    // Return limited data - only what's needed
    const responseData: Record<string, any> = {
      success: true,
      uid: userRecord.uid,
      email: userRecord.email || '',
      displayName: userRecord.displayName || '',
      photoURL: userRecord.photoURL || '',
      emailVerified: userRecord.emailVerified
    };

    // Only admins get sensitive metadata
    if (isAdmin) {
      responseData.disabled = userRecord.disabled;
      responseData.creationTime = userRecord.metadata.creationTime;
      responseData.lastSignInTime = userRecord.metadata.lastSignInTime;
    }

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[get-auth-email] Error:', error.code);

    if (error.code === 'auth/user-not-found') {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Don't expose internal error messages
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch user data'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
