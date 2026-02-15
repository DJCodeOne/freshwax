// src/pages/api/auth/verify-email-status.ts
// POST: Mark user's email as verified in Firestore after Firebase Auth confirms it
// Called by verify-email page when user clicks "I've Verified My Email"
import type { APIRoute } from 'astro';
import { updateDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Rate limit: auth tier - 10 per 15 minutes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`verify-email:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify with Firebase Auth that email is actually verified
    // verifyRequestUser calls accounts:lookup which returns user info
    // We need to check the emailVerified field from Firebase Auth directly
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || '';
    const apiKey = import.meta.env.FIREBASE_API_KEY || import.meta.env.PUBLIC_FIREBASE_API_KEY;

    const lookupResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );

    if (!lookupResponse.ok) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to verify email status with Firebase Auth'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const lookupData = await lookupResponse.json();
    const firebaseUser = lookupData.users?.[0];

    if (!firebaseUser?.emailVerified) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email has not been verified in Firebase Auth yet'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Email is confirmed verified in Firebase Auth — update Firestore
    await updateDocument('users', userId, {
      emailVerified: true,
      emailVerifiedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[verify-email-status] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update verification status'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
