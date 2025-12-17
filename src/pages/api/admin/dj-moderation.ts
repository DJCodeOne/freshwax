// src/pages/api/admin/dj-moderation.ts
// Admin API for DJ moderation: ban, hold, kick
// - Banned DJs cannot access DJ Lobby or Go Live
// - DJs on hold cannot go live but can view lobby
// - Kicked DJs have their stream ended but retain DJ role
// NOTE: getUserByEmail requires Firebase Admin SDK which doesn't work on Cloudflare

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

// GET: List banned and on-hold DJs
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
    const [bannedSnap, onholdSnap] = await Promise.all([
      queryCollection('djModeration', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'banned' }],
        orderBy: { field: 'bannedAt', direction: 'DESCENDING' },
        skipCache: true
      }),
      queryCollection('djModeration', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'hold' }],
        orderBy: { field: 'holdAt', direction: 'DESCENDING' },
        skipCache: true
      })
    ]);

    const banned = bannedSnap.map((doc: any) => ({
      id: doc.id,
      userId: doc.id,
      ...doc,
      bannedAt: doc.bannedAt instanceof Date ? doc.bannedAt.toISOString() : doc.bannedAt
    }));

    const onhold = onholdSnap.map((doc: any) => ({
      id: doc.id,
      userId: doc.id,
      ...doc,
      holdAt: doc.holdAt instanceof Date ? doc.holdAt.toISOString() : doc.holdAt
    }));

    return new Response(JSON.stringify({ success: true, banned, onhold }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[dj-moderation] Error listing:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Ban, unban, hold, release, or kick a DJ
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const data = await request.json();
    const { action, email, userId, reason, adminKey, targetUserId, targetUserName } = data;

    // Simple admin key check
    if (adminKey !== getAdminKey(locals)) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Note: getUserByEmail requires Firebase Admin SDK which doesn't work on Cloudflare
    // Instead, the admin interface should provide userId directly
    // This is a simplified version that works with userId or looks up by email in Firestore
    async function getUserIdFromEmail(email: string): Promise<{ userId: string; name: string | null } | null> {
      // Look up user by email in users collection
      try {
        const users = await queryCollection('users', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        });
        if (users.length > 0) {
          return { userId: users[0].id, name: users[0].displayName || users[0].name || null };
        }
        // Also check customers collection
        const customers = await queryCollection('customers', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        });
        if (customers.length > 0) {
          return { userId: customers[0].id, name: customers[0].displayName || customers[0].firstName || null };
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    const now = new Date().toISOString();

    if (action === 'ban') {
      if (!email) {
        return new Response(JSON.stringify({ success: false, error: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const user = await getUserIdFromEmail(email);
      if (!user) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found with that email'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Add to moderation collection
      await setDocument('djModeration', user.userId, {
        email,
        name: user.name,
        status: 'banned',
        reason: reason || null,
        bannedAt: new Date(),
        bannedBy: 'admin'
      });

      // Also end any active stream they have
      const activeStreams = await queryCollection('streams', {
        filters: [
          { field: 'djId', op: 'EQUAL', value: user.userId },
          { field: 'status', op: 'EQUAL', value: 'live' }
        ],
        skipCache: true
      });

      for (const stream of activeStreams) {
        await updateDocument('streams', stream.id, {
          status: 'ended',
          endedAt: now,
          endReason: 'banned'
        });
      }

      console.log(`[dj-moderation] Banned ${email} (${user.userId})`);

      return new Response(JSON.stringify({
        success: true,
        message: `${email} has been banned`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'unban') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await deleteDocument('djModeration', userId);

      console.log(`[dj-moderation] Unbanned ${userId}`);

      return new Response(JSON.stringify({
        success: true,
        message: 'DJ has been unbanned'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'hold') {
      if (!email) {
        return new Response(JSON.stringify({ success: false, error: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const user = await getUserIdFromEmail(email);
      if (!user) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found with that email'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Add to moderation collection with hold status
      await setDocument('djModeration', user.userId, {
        email,
        name: user.name,
        status: 'hold',
        reason: reason || null,
        holdAt: new Date(),
        holdBy: 'admin'
      });

      // End any active stream
      const activeStreams = await queryCollection('streams', {
        filters: [
          { field: 'djId', op: 'EQUAL', value: user.userId },
          { field: 'status', op: 'EQUAL', value: 'live' }
        ],
        skipCache: true
      });

      for (const stream of activeStreams) {
        await updateDocument('streams', stream.id, {
          status: 'ended',
          endedAt: now,
          endReason: 'hold'
        });
      }

      console.log(`[dj-moderation] Put ${email} on hold (${user.userId})`);

      return new Response(JSON.stringify({
        success: true,
        message: `${email} has been put on hold`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'release') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await deleteDocument('djModeration', userId);

      console.log(`[dj-moderation] Released ${userId} from hold`);

      return new Response(JSON.stringify({
        success: true,
        message: 'DJ has been released from hold'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'kick') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // End any active stream but don't ban
      const activeStreams = await queryCollection('streams', {
        filters: [
          { field: 'djId', op: 'EQUAL', value: userId },
          { field: 'status', op: 'EQUAL', value: 'live' }
        ],
        skipCache: true
      });

      if (activeStreams.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'DJ is not currently streaming'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      for (const stream of activeStreams) {
        await updateDocument('streams', stream.id, {
          status: 'ended',
          endedAt: now,
          endReason: 'kicked'
        });
      }

      // Update currentStream document if exists
      try {
        await updateDocument('livestream', 'currentStream', {
          isLive: false,
          endedAt: now
        });
      } catch (e) {
        // May not exist
      }

      console.log(`[dj-moderation] Kicked ${userId} from stream`);

      return new Response(JSON.stringify({
        success: true,
        message: 'DJ has been kicked from the stream'
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
    console.error('[dj-moderation] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
