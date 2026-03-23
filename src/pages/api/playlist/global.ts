// src/pages/api/playlist/global.ts
// Global playlist API - shared across all viewers
// NOW USES CLOUDFLARE KV - NO MORE FIREBASE READS!

import type { APIContext } from 'astro';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { isAdmin as checkIsAdmin, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { setKVCache, broadcastPlaylistUpdate } from '../../../lib/playlist/helpers';
import { KV_TTL } from '../../../lib/timeouts';
import { processPlaylistAction } from '../../../lib/playlist/actions';
import type { GlobalPlaylist, PlaylistItem } from '../../../lib/playlist/actions';

const log = createLogger('playlist/global');
import { z } from 'zod';

const PlaylistItemSchema = z.object({
  id: z.string().max(200).nullish(),
  url: z.string().max(2000).nullish(),
  platform: z.string().max(50).nullish(),
  embedId: z.string().max(500).nullish(),
  title: z.string().max(500).nullish(),
  thumbnail: z.string().max(2000).nullish(),
}).strip();

const PlaylistPostSchema = z.object({
  item: PlaylistItemSchema,
  userName: z.string().max(200).nullish(),
}).strip();

const PlaylistDeleteSchema = z.object({
  itemId: z.string().min(1).max(200),
}).strip();

const PlaylistPutSchema = z.object({
  action: z.string().min(1).max(50),
  userId: z.string().max(200).nullish(),
  playlist: z.object({
    queue: z.array(PlaylistItemSchema).nullish(),
    currentIndex: z.number().int().min(0).nullish(),
    isPlaying: z.boolean().nullish(),
    trackStartedAt: z.string().max(100).nullish(),
  }).strip().nullish(),
  trackId: z.string().max(200).nullish(),
  finishedTrackTitle: z.string().max(500).nullish(),
  emoji: z.string().max(50).nullish(),
  sessionId: z.string().max(200).nullish(),
}).strip();

// KV keys for playlist data
const KV_PLAYLIST_KEY = 'global-playlist';
const MAX_QUEUE_SIZE = 10;

// PlaylistItem and GlobalPlaylist types are imported from ../../../lib/playlist/actions

// Helper to get KV binding
function getKV(locals: App.Locals): KVNamespace | undefined {
  return locals.runtime.env?.CACHE;
}

// GET - Fetch global playlist from KV (NO FIREBASE!)
export async function GET({ request, locals }: APIContext) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=10, s-maxage=15', // Increased caching - Pusher handles real-time
    };

    const kv = getKV(locals);
    if (!kv) {
      log.error('[GlobalPlaylist] KV not available');
      return ApiErrors.serverError('Storage service temporarily unavailable');
    }

    // Get playlist from KV
    const data = await kv.get(KV_PLAYLIST_KEY, 'json');

    const playlist = data || {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString(),
      trackStartedAt: null
    };

    return successResponse({ playlist });
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] GET error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}

// POST - Add item to playlist (requires auth)
export async function POST({ request, locals }: APIContext) {
  // Rate limit: standard - 60 per minute
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`playlist-post:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    // SECURITY: Verify authentication
    const env = locals.runtime.env;
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (!verifiedUserId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const kv = getKV(locals);
    if (!kv) {
      return ApiErrors.serverError('KV storage not available');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = PlaylistPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { item, userName } = parseResult.data;
    // SECURITY: Use verified userId, ignore client-provided userId
    const userId = verifiedUserId;

    // Get current playlist from KV
    let playlist: GlobalPlaylist = {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString(),
      trackStartedAt: null
    };

    const data = await kv.get(KV_PLAYLIST_KEY, 'json');
    if (data) {
      playlist = {
        queue: data.queue || [],
        currentIndex: data.currentIndex || 0,
        isPlaying: data.isPlaying || false,
        lastUpdated: data.lastUpdated || new Date().toISOString(),
        trackStartedAt: data.trackStartedAt || null,
        reactionCount: data.reactionCount || 0
      };
    }

    // Check queue size
    if (playlist.queue.length >= MAX_QUEUE_SIZE) {
      return ApiErrors.badRequest('Queue is full (${MAX_QUEUE_SIZE} items max)');
    }

    // DJ Waitlist: Check if user already has max tracks in queue (2 tracks per DJ)
    const userTracksInQueue = playlist.queue.filter(item => item.addedBy === userId).length;
    if (userTracksInQueue >= 2) {
      return ApiErrors.badRequest('You already have 2 tracks in the queue. Wait for one to play or remove it first.');
    }

    // Add item with user info
    const newItem: PlaylistItem = {
      ...item,
      addedBy: userId,
      addedByName: userName || 'Anonymous',
      addedAt: new Date().toISOString()
    };

    playlist.queue.push(newItem);
    playlist.lastUpdated = new Date().toISOString();

    // If first item, start playing and set track start time
    if (playlist.queue.length === 1 && !playlist.isPlaying) {
      playlist.isPlaying = true;
      playlist.trackStartedAt = new Date().toISOString();
    }

    // Save to KV
    await kv.put(KV_PLAYLIST_KEY, JSON.stringify({
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null,
      reactionCount: playlist.reactionCount || 0
    }), { expirationTtl: KV_TTL.ONE_DAY });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, locals.runtime.env);

    return successResponse({ playlist,
      message: playlist.queue.length === 1 ? 'Now playing' : 'Added to queue' });
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] POST error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}

// DELETE - Remove item from playlist
export async function DELETE({ request, locals }: APIContext) {
  // Rate limit: write - 30 per minute
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`playlist-delete:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    // SECURITY: Verify authentication
    const env = locals.runtime.env;
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (!verifiedUserId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const kv = getKV(locals);
    if (!kv) {
      return ApiErrors.serverError('KV storage not available');
    }

    let rawDeleteBody: unknown;
    try {
      rawDeleteBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const deleteParseResult = PlaylistDeleteSchema.safeParse(rawDeleteBody);
    if (!deleteParseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { itemId } = deleteParseResult.data;
    // SECURITY: Use verified userId, verify admin status server-side
    const userId = verifiedUserId;
    initAdminEnv(env);
    const userIsAdmin = await checkIsAdmin(userId);

    const data = await kv.get(KV_PLAYLIST_KEY, 'json');

    if (!data) {
      return ApiErrors.notFound('Playlist not found');
    }

    let playlist: GlobalPlaylist = {
      queue: data.queue || [],
      currentIndex: data.currentIndex || 0,
      isPlaying: data.isPlaying || false,
      lastUpdated: data.lastUpdated || new Date().toISOString(),
      trackStartedAt: data.trackStartedAt || null
    };

    // Find and remove item (only if user owns it or is admin)
    const itemIndex = playlist.queue.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      return ApiErrors.notFound('Item not found');
    }

    const item = playlist.queue[itemIndex];
    // Allow removal if user owns the item OR is verified admin
    if (!userIsAdmin && item.addedBy !== userId) {
      return ApiErrors.forbidden('You can only remove your own items');
    }

    const wasCurrentlyPlaying = itemIndex === playlist.currentIndex;
    playlist.queue.splice(itemIndex, 1);

    // Adjust currentIndex
    if (itemIndex < playlist.currentIndex) {
      playlist.currentIndex = Math.max(0, playlist.currentIndex - 1);
    } else if (itemIndex === playlist.currentIndex && playlist.queue.length > 0) {
      playlist.currentIndex = Math.min(playlist.currentIndex, playlist.queue.length - 1);
    }

    // Stop if queue is empty
    if (playlist.queue.length === 0) {
      playlist.isPlaying = false;
      playlist.currentIndex = 0;
      playlist.trackStartedAt = null;
    } else if (wasCurrentlyPlaying) {
      // Reset track start time if we removed the current track (new track starts)
      playlist.trackStartedAt = new Date().toISOString();
    }

    playlist.lastUpdated = new Date().toISOString();

    // Save to KV
    await kv.put(KV_PLAYLIST_KEY, JSON.stringify({
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null,
      reactionCount: playlist.reactionCount || 0
    }), { expirationTtl: KV_TTL.ONE_DAY });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, locals.runtime.env);

    return successResponse({ playlist });
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] DELETE error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}

// PUT - Update playlist state (next track, play/pause, sync)
export async function PUT({ request, locals }: APIContext) {
  // Rate limit: standard - 60 per minute
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`playlist-put:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const kv = getKV(locals);
    if (!kv) {
      return ApiErrors.serverError('KV storage not available');
    }

    // Set KV cache for helper functions
    setKVCache(kv);

    const env = locals.runtime.env;
    let rawPutBody: unknown;
    try {
      rawPutBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const putParseResult = PlaylistPutSchema.safeParse(rawPutBody);
    if (!putParseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const body = putParseResult.data;
    const { action, userId, playlist: syncPlaylist } = body;

    let playlist: GlobalPlaylist;

    // For 'sync' action, use the provided playlist directly
    if (action === 'sync' && syncPlaylist) {
      playlist = {
        queue: syncPlaylist.queue || [],
        currentIndex: syncPlaylist.currentIndex || 0,
        isPlaying: syncPlaylist.isPlaying || false,
        lastUpdated: new Date().toISOString(),
        trackStartedAt: syncPlaylist.trackStartedAt || null
      };
    } else {
      // For other actions, load from KV first
      const data = await kv.get(KV_PLAYLIST_KEY, 'json');

      if (!data) {
        // Create empty playlist if none exists
        playlist = {
          queue: [],
          currentIndex: 0,
          isPlaying: false,
          lastUpdated: new Date().toISOString(),
          trackStartedAt: null,
          reactionCount: 0
        };
      } else {
        playlist = {
          queue: data.queue || [],
          currentIndex: data.currentIndex || 0,
          isPlaying: data.isPlaying || false,
          lastUpdated: data.lastUpdated || new Date().toISOString(),
          trackStartedAt: data.trackStartedAt || null,
          reactionCount: data.reactionCount || 0
        };
      }

      // Process the action using extracted handler
      const actionResult = await processPlaylistAction(action, playlist, body as Record<string, unknown>, env);
      playlist = actionResult.playlist;

      // Handle early returns (e.g. race protection in trackEnded)
      if (actionResult.earlyReturn) {
        return successResponse(actionResult.earlyReturn);
      }
    }

    // Save to KV
    await kv.put(KV_PLAYLIST_KEY, JSON.stringify({
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null,
      reactionCount: playlist.reactionCount || 0
    }), { expirationTtl: KV_TTL.ONE_DAY });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, locals.runtime.env);

    return successResponse({ playlist });
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] PUT error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}

