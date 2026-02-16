// src/pages/api/admin/dj-moderation.ts
// Admin API for DJ moderation: ban, hold, kick
// - Banned DJs cannot access DJ Lobby or Go Live
// - DJs on hold cannot go live but can view lobby
// - Kicked DJs have their stream ended but retain DJ role
// NOTE: getUserByEmail requires Firebase Admin SDK which doesn't work on Cloudflare

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, deleteDocument } from '../../../lib/firebase-rest';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

const djModerationPostSchema = z.object({
  action: z.enum(['ban', 'unban', 'hold', 'release', 'kick']),
  email: z.string().email().optional(),
  userId: z.string().optional(),
  reason: z.string().optional(),
  adminKey: z.string().optional(),
  targetUserId: z.string().optional(),
  targetUserName: z.string().optional(),
});

// Helper to get admin key from environment
function getAdminKey(locals: App.Locals): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}



// GET: List banned and on-hold DJs
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`dj-moderation:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);



  // SECURITY: Require admin authentication for listing moderation data
  const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action !== 'list') {
    return ApiErrors.badRequest('Invalid action');
  }

  try {
    const [bannedSnap, onholdSnap] = await Promise.all([
      queryCollection('djModeration', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'banned' }],
        orderBy: { field: 'bannedAt', direction: 'DESCENDING' },
        skipCache: true,
        limit: 200
      }),
      queryCollection('djModeration', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'hold' }],
        orderBy: { field: 'holdAt', direction: 'DESCENDING' },
        skipCache: true,
        limit: 200
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
  } catch (error: unknown) {
    console.error('[dj-moderation] Error listing:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// POST: Ban, unban, hold, release, or kick a DJ
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`dj-moderation-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);


  const saQuery = getSaQuery(locals);
  try {
    const data = await request.json();

    // SECURITY: Use requireAdminAuth for consistent timing-safe comparison
    const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
    const env = locals?.runtime?.env;
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const postAuthError = await requireAdminAuth(request, locals, data);
    if (postAuthError) return postAuthError;

    const parsed = djModerationPostSchema.safeParse(data);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, email, userId, reason } = parsed.data;

    // Note: getUserByEmail requires Firebase Admin SDK which doesn't work on Cloudflare
    // Instead, the admin interface should provide userId directly
    // This is a simplified version that works with userId or looks up by email in Firestore
    async function getUserIdFromEmail(email: string): Promise<{ userId: string; name: string | null } | null> {
      // Look up user by email in users collection
      try {
        const users = await saQuery('users', {
          filters: [{ field: 'email', op: 'EQUAL', value: email }],
          limit: 1
        });
        if (users.length > 0) {
          return { userId: users[0].id, name: users[0].displayName || users[0].name || null };
        }
        // Also check customers collection
        const customers = await saQuery('users', {
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
        return ApiErrors.badRequest('Email required');
      }

      const user = await getUserIdFromEmail(email);
      if (!user) {
        return ApiErrors.notFound('User not found with that email');
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
        skipCache: true,
        limit: 10
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
        return ApiErrors.badRequest('User ID required');
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
        return ApiErrors.badRequest('Email required');
      }

      const user = await getUserIdFromEmail(email);
      if (!user) {
        return ApiErrors.notFound('User not found with that email');
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
        skipCache: true,
        limit: 10
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
        return ApiErrors.badRequest('User ID required');
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
        return ApiErrors.badRequest('User ID required');
      }

      // End any active stream but don't ban
      const activeStreams = await queryCollection('streams', {
        filters: [
          { field: 'djId', op: 'EQUAL', value: userId },
          { field: 'status', op: 'EQUAL', value: 'live' }
        ],
        skipCache: true,
        limit: 10
      });

      if (activeStreams.length === 0) {
        return ApiErrors.badRequest('DJ is not currently streaming');
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
      return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    console.error('[dj-moderation] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
