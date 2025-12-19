// src/pages/api/admin/lobby-bypass.ts
// Admin API for managing DJ lobby access bypass
// Allows admins to grant/revoke access to DJs who don't meet the 10 likes requirement
// NOTE: getUserByEmail functionality replaced with Firestore lookup (Firebase Admin doesn't work on Cloudflare)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

// Helper to get admin key from environment
function getAdminKey(locals: any): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET: List all bypass approvals
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action !== 'list') {
    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const snapshot = await queryCollection('djLobbyBypass', {
      orderBy: { field: 'grantedAt', direction: 'DESCENDING' },
      skipCache: true
    });

    const bypasses = snapshot.map((doc: any) => ({
      id: doc.id,
      userId: doc.id,
      ...doc,
      grantedAt: doc.grantedAt instanceof Date ? doc.grantedAt.toISOString() : doc.grantedAt
    }));

    return new Response(JSON.stringify({ success: true, bypasses }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[lobby-bypass] Error listing:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Grant or revoke bypass
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const data = await request.json();
    const { action, email, userId, reason, adminKey } = data;

    // Simple admin key check
    if (adminKey !== getAdminKey(locals)) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'grant') {
      if (!email) {
        return new Response(JSON.stringify({ success: false, error: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Find user by email in Firestore (Firebase Auth Admin SDK doesn't work on Cloudflare)
      let targetUserId: string | null = null;
      let userName: string | null = null;

      // Search all user collections in parallel for efficiency
      const [users, customers, artists] = await Promise.all([
        queryCollection('users', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        }),
        queryCollection('customers', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        }),
        queryCollection('artists', {
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
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found with that email. They need to create an account first.'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
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
      } catch (updateError: any) {
        // If update fails (doc doesn't exist or permission), try to create
        try {
          await setDocument('users', targetUserId, userUpdateData);
        } catch (createError: any) {
          // Log but don't fail - the djLobbyBypass entry was created successfully
          console.warn(`[lobby-bypass] Could not set user bypass flag: ${createError.message}`);
        }
      }

      console.log(`[lobby-bypass] Granted bypass to ${email} (${targetUserId})`);

      return new Response(JSON.stringify({
        success: true,
        message: `Lobby access granted to ${email}`,
        userId: targetUserId
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'revoke') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Revoke bypass from collection
      await deleteDocument('djLobbyBypass', userId);

      // Also remove bypass flag from user document
      try {
        await updateDocument('users', userId, {
          'go-liveBypassed': false,
          bypassRevokedAt: new Date().toISOString()
        });
      } catch (e) {
        // User doc might not exist, that's ok
      }

      console.log(`[lobby-bypass] Revoked bypass for ${userId}`);

      return new Response(JSON.stringify({
        success: true,
        message: 'Bypass revoked'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else {
      return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error: any) {
    console.error('[lobby-bypass] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
