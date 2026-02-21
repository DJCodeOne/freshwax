// src/pages/api/livestream/listeners.ts
// API endpoint for tracking and retrieving active listeners on a live stream
// Uses Cloudflare KV for fast, edge-cached listener tracking (no Firebase)

import type { APIRoute } from 'astro';
import { initKVCache, kvGet, kvSet, kvDelete } from '../../../lib/kv-cache';
import { triggerPusher } from '../../../lib/pusher';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('livestream/listeners');

export const prerender = false;

const LISTENER_TTL = 120; // 2 minutes - listeners expire if no heartbeat

// Helper to initialize KV
function initKV(locals: App.Locals) {
  const env = locals?.runtime?.env;
  initKVCache(env);
  return env;
}

// Get listener count from KV
async function getListenerCount(streamId: string): Promise<{ count: number; listeners: any[] }> {
  try {
    // Get the listener list for this stream
    const listKey = `listeners:${streamId}`;
    const listenerMap = await kvGet<Record<string, { name: string; avatar?: string; lastSeen: number }>>(listKey, { prefix: 'stream' });

    if (!listenerMap) {
      return { count: 0, listeners: [] };
    }

    // Filter out expired listeners (older than 2 minutes)
    const now = Date.now();
    const twoMinutesAgo = now - (2 * 60 * 1000);
    const activeListeners: any[] = [];

    for (const [userId, data] of Object.entries(listenerMap)) {
      if (data.lastSeen > twoMinutesAgo) {
        activeListeners.push({
          id: userId,
          name: data.name || 'Viewer',
          avatarUrl: data.avatar || null
        });
      }
    }

    return { count: activeListeners.length, listeners: activeListeners };
  } catch (e: unknown) {
    log.error('Error getting count:', e);
    return { count: 0, listeners: [] };
  }
}

// Add or update a listener in KV
async function upsertListener(
  streamId: string,
  userId: string,
  userName?: string,
  avatarUrl?: string
): Promise<number> {
  try {
    const listKey = `listeners:${streamId}`;

    // Get current listeners
    let listenerMap = await kvGet<Record<string, { name: string; avatar?: string; lastSeen: number }>>(listKey, { prefix: 'stream' }) || {};

    // Clean up expired listeners while we're here
    const now = Date.now();
    const twoMinutesAgo = now - (2 * 60 * 1000);
    for (const [id, data] of Object.entries(listenerMap)) {
      if (data.lastSeen < twoMinutesAgo) {
        delete listenerMap[id];
      }
    }

    // Add/update this listener
    listenerMap[userId] = {
      name: userName || 'Viewer',
      avatar: avatarUrl,
      lastSeen: now
    };

    // Save back to KV with TTL
    await kvSet(listKey, listenerMap, { prefix: 'stream', ttl: LISTENER_TTL });

    // Count active listeners
    return Object.keys(listenerMap).length;
  } catch (e: unknown) {
    log.error('Error upserting:', e);
    return 0;
  }
}

// Remove a listener from KV
async function removeListener(streamId: string, userId: string): Promise<number> {
  try {
    const listKey = `listeners:${streamId}`;

    // Get current listeners
    let listenerMap = await kvGet<Record<string, { name: string; avatar?: string; lastSeen: number }>>(listKey, { prefix: 'stream' }) || {};

    // Remove this listener
    delete listenerMap[userId];

    // Clean up expired while we're here
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
    for (const [id, data] of Object.entries(listenerMap)) {
      if (data.lastSeen < twoMinutesAgo) {
        delete listenerMap[id];
      }
    }

    // Save back to KV
    if (Object.keys(listenerMap).length > 0) {
      await kvSet(listKey, listenerMap, { prefix: 'stream', ttl: LISTENER_TTL });
    } else {
      await kvDelete(listKey, { prefix: 'stream' });
    }

    return Object.keys(listenerMap).length;
  } catch (e: unknown) {
    log.error('Error removing:', e);
    return 0;
  }
}

// GET - Retrieve list of active listeners for a stream
export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`listeners:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  initKV(locals);

  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');

    if (!streamId) {
      return ApiErrors.badRequest('Stream ID required');
    }

    const { count, listeners } = await getListenerCount(streamId);

    return new Response(JSON.stringify({
      success: true,
      listeners,
      count
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error fetching listeners:', error);
    return ApiErrors.serverError('Failed to fetch listeners');
  }
};

// POST - Join, leave, or heartbeat as a listener
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rl = checkRateLimit(`listeners:${clientId}`, RateLimiters.standard);
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter!);
  }

  const env = initKV(locals);

  try {
    let body;

    // Handle both JSON and sendBeacon (text/plain) requests
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      const text = await request.text();
      body = JSON.parse(text);
    }

    const { action, streamId, userId: bodyUserId, userName, avatarUrl } = body;

    if (!streamId) {
      return ApiErrors.badRequest('Stream ID required');
    }

    // SECURITY: Verify userId from auth token when present, fall back to body for anonymous tracking
    let userId = bodyUserId;
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyRequestUser } = await import('../../../lib/firebase-rest');
        const { userId: verifiedId } = await verifyRequestUser(request);
        if (verifiedId) userId = verifiedId;
      } catch { /* anonymous viewer */ }
    }

    // Require some form of userId for tracking
    if (!userId) {
      // Generate anonymous ID from request for basic tracking
      userId = `anon_${Date.now().toString(36)}`;
    }

    let activeCount: number;

    if (action === 'leave') {
      // Remove listener
      activeCount = await removeListener(streamId, userId);

      // Broadcast update via Pusher
      const channel = `stream-${streamId}`;
      await triggerPusher(channel, 'viewer-update', {
        count: activeCount,
        streamId,
        timestamp: Date.now()
      }, env);

      return new Response(JSON.stringify({
        success: true,
        message: 'Left stream',
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else {
      // Join or heartbeat - both upsert the listener
      activeCount = await upsertListener(streamId, userId, userName, avatarUrl);

      // Broadcast update via Pusher
      const channel = `stream-${streamId}`;
      await triggerPusher(channel, 'viewer-update', {
        count: activeCount,
        streamId,
        timestamp: Date.now()
      }, env);

      return new Response(JSON.stringify({
        success: true,
        message: action === 'join' ? 'Joined as listener' : 'Heartbeat received',
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error: unknown) {
    log.error('Error updating listener:', error);
    return ApiErrors.serverError('Failed to update listener status');
  }
};
