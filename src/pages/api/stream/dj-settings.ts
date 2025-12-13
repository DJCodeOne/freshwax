// src/pages/api/stream/dj-settings.ts
// Admin endpoint to add/update DJ settings and grant streaming access
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();
const auth = getAuth();

const ADMIN_KEY = 'freshwax-admin-2024';

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { userId, djName, twitchChannel, isApproved, adminKey } = data;

    // Simple admin key check
    if (adminKey !== ADMIN_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try to get user info from Firebase Auth
    let email = '';
    let displayName = djName || '';

    try {
      const userRecord = await auth.getUser(userId);
      email = userRecord.email || '';
      displayName = djName || userRecord.displayName || email.split('@')[0] || 'DJ';
    } catch (e) {
      // User might not exist in Auth, that's ok
      console.warn(`[dj-settings] User ${userId} not found in Auth`);
    }

    // Generate mount point based on user ID
    const mountPoint = `/live/${userId.substring(0, 8)}`;

    if (isApproved) {
      // Grant access - add to djLobbyBypass collection
      await db.collection('djLobbyBypass').doc(userId).set({
        email,
        name: displayName,
        twitchChannel: twitchChannel || null,
        mountPoint,
        grantedAt: FieldValue.serverTimestamp(),
        grantedBy: 'admin'
      });

      // Also set user's bypass flag
      await db.collection('users').doc(userId).set({
        'go-liveBypassed': true,
        bypassedAt: new Date().toISOString(),
        bypassedBy: 'admin'
      }, { merge: true });

      console.log(`[dj-settings] Granted streaming access to ${displayName} (${userId})`);
    } else {
      // Revoke access
      await db.collection('djLobbyBypass').doc(userId).delete();

      // Remove bypass flag
      try {
        await db.collection('users').doc(userId).update({
          'go-liveBypassed': false,
          bypassRevokedAt: new Date().toISOString()
        });
      } catch (e) {
        // User doc might not exist
      }

      console.log(`[dj-settings] Revoked streaming access for ${displayName} (${userId})`);
    }

    return new Response(JSON.stringify({
      success: true,
      message: isApproved ? 'DJ added and approved' : 'DJ access revoked',
      mountPoint: isApproved ? mountPoint : null,
      userId,
      djName: displayName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[dj-settings] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
