// src/pages/api/user/profile.ts
// Get user profile data including approved relay info
// SECURITY: Requires authentication - user can only view their own profile
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';

export const prerender = false;

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    // SECURITY: Verify the requesting user's identity
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

    // User can only fetch their own profile

    // Fetch user data
    const userData = await getDocument('users', userId);

    if (!userData) {
      return new Response(JSON.stringify({
        success: true,
        user: null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Return relevant user data (excluding sensitive fields)
    return new Response(JSON.stringify({
      success: true,
      user: {
        displayName: userData.displayName || userData.name,
        email: userData.email,
        subscription: userData.subscription,
        approvedRelay: userData.approvedRelay || null,
        bypassedAt: userData.bypassedAt,
        'go-liveBypassed': userData['go-liveBypassed']
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[user/profile] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch user profile'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
