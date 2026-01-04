// src/pages/api/auth/session.ts
// Verify user session via Firebase ID token
// Accepts Authorization: Bearer <idToken> header

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Rate limit: auth attempts - 10 per 15 minutes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`auth-session:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify the Firebase ID token from Authorization header
    const { userId, error } = await verifyRequestUser(request);

    if (error || !userId) {
      return new Response(JSON.stringify({
        success: false,
        authenticated: false,
        message: error || 'No valid session'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch user profile from Firestore
    const userDoc = await getDocument('users', userId);

    return new Response(JSON.stringify({
      success: true,
      authenticated: true,
      userId,
      user: userDoc ? {
        displayName: userDoc.displayName || null,
        email: userDoc.email || null,
        role: userDoc.role || 'user',
        isArtist: userDoc.isArtist || false,
        isPro: userDoc.isPro || false,
      } : null
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[auth/session] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      authenticated: false,
      error: 'Session verification failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
