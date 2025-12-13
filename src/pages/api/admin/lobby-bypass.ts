// src/pages/api/admin/lobby-bypass.ts
// Admin API for managing DJ lobby access bypass
// Allows admins to grant/revoke access to DJs who don't meet the 10 likes requirement

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, deleteDocument } from '../../../lib/firebase-rest';
// NOTE: Firebase Admin Auth is still needed for getUserByEmail functionality
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const auth = getAuth();
const ADMIN_KEY = 'freshwax-admin-2024';

// GET: List all bypass approvals
export const GET: APIRoute = async ({ request }) => {
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
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action, email, userId, reason, adminKey } = data;

    // Simple admin key check
    if (adminKey !== ADMIN_KEY) {
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

      // Find user by email using Firebase Auth
      let targetUserId: string;
      let userName: string | null = null;

      try {
        const userRecord = await auth.getUserByEmail(email);
        targetUserId = userRecord.uid;
        userName = userRecord.displayName || null;
      } catch (e) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found with that email. They need to create an account first.'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Grant bypass
      await setDocument('djLobbyBypass', targetUserId, {
        email,
        name: userName,
        reason: reason || null,
        grantedAt: new Date(),
        grantedBy: 'admin'
      });

      // Also set user's bypass flag
      const existingUser = await getDocument('users', targetUserId);
      const userUpdateData = {
        'go-liveBypassed': true,
        bypassedAt: new Date().toISOString(),
        bypassedBy: 'admin'
      };

      if (existingUser) {
        await updateDocument('users', targetUserId, userUpdateData);
      } else {
        await setDocument('users', targetUserId, userUpdateData);
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
