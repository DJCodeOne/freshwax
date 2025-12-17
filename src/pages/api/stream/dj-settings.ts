// src/pages/api/stream/dj-settings.ts
// Admin endpoint to add/update DJ settings and grant streaming access
import type { APIRoute } from 'astro';
import { setDocument, updateDocument, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to get admin key from environment
function getAdminKey(locals: any): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const data = await request.json();
    const { userId, djName, twitchChannel, isApproved, adminKey } = data;

    // Simple admin key check
    if (adminKey !== getAdminKey(locals)) {
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

    // Note: Firebase Auth operations (auth.getUser) are not available in REST API
    // We'll use the provided data directly
    let email = '';
    let displayName = djName || 'DJ';

    // Generate mount point based on user ID
    const mountPoint = `/live/${userId.substring(0, 8)}`;

    if (isApproved) {
      // Grant access - add to djLobbyBypass collection
      await setDocument('djLobbyBypass', userId, {
        email,
        name: displayName,
        twitchChannel: twitchChannel || null,
        mountPoint,
        grantedAt: new Date().toISOString(),
        grantedBy: 'admin'
      });

      // Also set user's bypass flag
      await setDocument('users', userId, {
        'go-liveBypassed': true,
        bypassedAt: new Date().toISOString(),
        bypassedBy: 'admin'
      });

      console.log(`[dj-settings] Granted streaming access to ${displayName} (${userId})`);
    } else {
      // Revoke access
      await deleteDocument('djLobbyBypass', userId);

      // Remove bypass flag
      try {
        await updateDocument('users', userId, {
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
