// src/pages/api/dj-lobby/presence.ts
// DJ Lobby presence tracking - Pusher-based (no Firebase onSnapshot)
// Replaces client-side Firebase listener with server-mediated Pusher events

import type { APIRoute } from 'astro';
import { updateDocument, setDocument, deleteDocument, queryCollection, verifyUserToken } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { simpleMd5 } from '../../../lib/pusher';
const log = createLogger('[dj-lobby/presence]');
import { z } from 'zod';

const PresenceSchema = z.object({
  action: z.enum(['join', 'leave', 'heartbeat', 'update']),
  userId: z.string().min(1).max(200),
  name: z.string().max(200).nullish(),
  avatar: z.string().max(2000).nullish(),
  avatarLetter: z.string().max(5).nullish(),
  isReady: z.boolean().nullish(),
}).strip();

// Pusher configuration is loaded from env at runtime (not module level)
// This is required for Cloudflare Workers compatibility

// Web Crypto API helper for HMAC-SHA256 (hex output)
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBuffer = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Trigger Pusher event
async function triggerPusher(channel: string, event: string, data: Record<string, unknown>, env?: Record<string, unknown>): Promise<boolean> {
  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
    log.error('[Pusher] Missing configuration');
    return false;
  }

  try {
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });

    const bodyMd5 = simpleMd5(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const params = new URLSearchParams({
      auth_key: PUSHER_KEY,
      auth_timestamp: timestamp,
      auth_version: '1.0',
      body_md5: bodyMd5
    });
    params.sort();

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\n${params.toString()}`;
    const signature = await hmacSha256Hex(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?${params.toString()}&auth_signature=${signature}`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    if (!response.ok) {
      log.error('[Pusher] Failed:', response.status, await response.text());
      return false;
    }

    return true;
  } catch (error: unknown) {
    log.error('[Pusher] Error:', error);
    return false;
  }
}

// In-memory cache for online DJs (reduces Firebase reads)
const onlineDjsCache = new Map<string, { data: Record<string, unknown>[]; expires: number }>();
const CACHE_TTL = 30 * 1000; // 30 seconds

function getCachedOnlineDjs(): Record<string, unknown>[] | null {
  const cached = onlineDjsCache.get('online-djs');
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }
  return null;
}

function setCachedOnlineDjs(djs: Record<string, unknown>[]): void {
  onlineDjsCache.set('online-djs', {
    data: djs,
    expires: Date.now() + CACHE_TTL
  });
}

// GET: Get online DJs list (initial load and polling fallback)
export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: 30 requests per minute per client
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`presence-get:${clientId}`, {
    maxRequests: 30,
    windowMs: 60 * 1000
  });
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = locals.runtime.env;
  const firebaseApiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
  const firebaseProjectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;

  try {
    // Check cache first
    const cached = getCachedOnlineDjs();
    if (cached) {
      return successResponse({ djs: cached,
        source: 'cache' }, 200, { headers: { 'Cache-Control': 'public, max-age=10' } });
    }

    // Query all presence documents and filter client-side
    // (timestamp filters in REST API can be unreliable)
    const allDjs = await queryCollection('djLobbyPresence', {
      cacheTime: 15000, // 15 second cache - presence doesn't need to be instant
      limit: 100
    });

    // Filter to DJs active in last 2 minutes
    const twoMinutesAgo = Date.now() - 120000;
    const activeDjs = allDjs.filter(dj => {
      if (!dj.lastSeen) return false;
      try {
        const lastSeenTime = dj.lastSeen instanceof Date
          ? dj.lastSeen.getTime()
          : new Date(dj.lastSeen).getTime();
        return !isNaN(lastSeenTime) && lastSeenTime > twoMinutesAgo;
      } catch (e: unknown) {
        return false;
      }
    });

    // Add odamiMa field for compatibility
    const djsWithOdamiMa = activeDjs.map(dj => ({ ...dj, odamiMa: dj.id }));

    // Cache the result
    setCachedOnlineDjs(djsWithOdamiMa);

    return successResponse({ djs: djsWithOdamiMa,
      source: 'firestore',
      debug: { total: allDjs.length, active: activeDjs.length } }, 200, { headers: { 'Cache-Control': 'public, max-age=10' } });

  } catch (error: unknown) {
    log.error('[dj-lobby/presence] GET Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get online DJs');
  }
};

// POST: Join/Leave/Heartbeat
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: 20 requests per minute per client (covers join/leave/heartbeat)
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`presence-post:${clientId}`, {
    maxRequests: 20,
    windowMs: 60 * 1000
  });
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = locals.runtime.env;

  // Get idToken from Authorization header
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = PresenceSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const { action, userId, name, avatar, avatarLetter, isReady } = data;

    // SECURITY: Verify the token-authenticated user matches the userId in the body
    // to prevent one user from impersonating another's presence
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only update your own presence');
    }

    const now = new Date();

    switch (action) {
      case 'join': {
        // Update presence document
        await setDocument('djLobbyPresence', userId, {
          odamiMa: userId,
          name: name || 'DJ',
          avatar: avatar || null,
          avatarLetter: avatarLetter || (name ? name.charAt(0).toUpperCase() : 'D'),
          isReady: isReady || false,
          lastSeen: now,
          joinedAt: now
        }, idToken);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast to all lobby members via Pusher
        await triggerPusher('dj-lobby', 'dj-joined', {
          id: userId,
          odamiMa: userId,
          name: name || 'DJ',
          avatar: avatar || null,
          avatarLetter: avatarLetter || (name ? name.charAt(0).toUpperCase() : 'D'),
          isReady: isReady || false,
          timestamp: now.toISOString()
        }, env);

        return successResponse({ message: 'Joined lobby' });
      }

      case 'leave': {
        // Delete presence document
        await deleteDocument('djLobbyPresence', userId, idToken);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast leave event
        await triggerPusher('dj-lobby', 'dj-left', {
          id: userId,
          timestamp: now.toISOString()
        }, env);

        return successResponse({ message: 'Left lobby' });
      }

      case 'heartbeat': {
        // Update last seen timestamp
        await updateDocument('djLobbyPresence', userId, {
          lastSeen: now,
          isReady: isReady ?? false
        }, idToken);

        // Broadcast status update if ready state changed
        if (typeof isReady === 'boolean') {
          await triggerPusher('dj-lobby', 'dj-status', {
            id: userId,
            isReady,
            timestamp: now.toISOString()
          }, env);
        }

        return successResponse({ message: 'Heartbeat recorded' });
      }

      case 'update': {
        // Update DJ info (name, avatar, ready state)
        const updateData: Record<string, unknown> = { lastSeen: now };
        if (name) updateData.name = name;
        if (avatar !== undefined) updateData.avatar = avatar;
        if (avatarLetter) updateData.avatarLetter = avatarLetter;
        if (typeof isReady === 'boolean') updateData.isReady = isReady;

        await updateDocument('djLobbyPresence', userId, updateData, idToken);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast update
        await triggerPusher('dj-lobby', 'dj-updated', {
          id: userId,
          ...updateData,
          timestamp: now.toISOString()
        }, env);

        return successResponse({ message: 'Updated' });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    log.error('[dj-lobby/presence] POST Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update presence');
  }
};

// DELETE: Cleanup stale presence entries (cron job endpoint)
// AUTH: Intentionally unauthenticated — only deletes presence entries with lastSeen
// older than 2 minutes. This is a housekeeping operation that removes stale data
// from disconnected users. No user data is exposed or modified.
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const deleteClientId = getClientId(request);
  const deleteRateLimit = checkRateLimit(`presence-delete:${deleteClientId}`, RateLimiters.standard);
  if (!deleteRateLimit.allowed) {
    return rateLimitResponse(deleteRateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const twoMinutesAgo = new Date(Date.now() - 120000);

    const staleDjs = await queryCollection('djLobbyPresence', {
      filters: [{ field: 'lastSeen', op: 'LESS_THAN', value: twoMinutesAgo }],
      limit: 100  // Limit cleanup batch size
    });

    const staleIds: string[] = staleDjs.map(dj => dj.id);

    if (staleIds.length > 0) {
      // Delete each stale presence document
      await Promise.allSettled(staleIds.map(id => deleteDocument('djLobbyPresence', id)));

      // Invalidate cache
      onlineDjsCache.delete('online-djs');

      // Broadcast cleanup in parallel instead of sequential N+1
      const now = new Date().toISOString();
      await Promise.allSettled(staleIds.map(id =>
        triggerPusher('dj-lobby', 'dj-left', {
          id,
          reason: 'timeout',
          timestamp: now
        }, env)
      ));
    }

    return successResponse({ cleaned: staleIds.length });

  } catch (error: unknown) {
    log.error('[dj-lobby/presence] DELETE Error:', error);
    return ApiErrors.serverError('Cleanup failed');
  }
};
