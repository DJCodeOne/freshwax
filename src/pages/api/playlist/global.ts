// src/pages/api/playlist/global.ts
// Global playlist API - shared across all viewers
// NOW USES CLOUDFLARE KV - NO MORE FIREBASE READS!

import type { APIContext } from 'astro';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { isAdmin as checkIsAdmin, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { simpleMd5 } from '../../../lib/pusher';

const log = createLogger('playlist/global');
import { z } from 'zod';

const PlaylistItemSchema = z.object({
  id: z.string().max(200).nullish(),
  url: z.string().max(2000).nullish(),
  platform: z.string().max(50).nullish(),
  embedId: z.string().max(500).nullish(),
  title: z.string().max(500).nullish(),
  thumbnail: z.string().max(2000).nullish(),
}).passthrough();

const PlaylistPostSchema = z.object({
  item: PlaylistItemSchema,
  userName: z.string().max(200).nullish(),
}).passthrough();

const PlaylistDeleteSchema = z.object({
  itemId: z.string().min(1).max(200),
}).passthrough();

const PlaylistPutSchema = z.object({
  action: z.string().min(1).max(50),
  userId: z.string().max(200).nullish(),
  playlist: z.object({
    queue: z.array(z.unknown()).nullish(),
    currentIndex: z.number().int().min(0).nullish(),
    isPlaying: z.boolean().nullish(),
    trackStartedAt: z.string().max(100).nullish(),
  }).passthrough().nullish(),
  trackId: z.string().max(200).nullish(),
  finishedTrackTitle: z.string().max(500).nullish(),
  emoji: z.string().max(50).nullish(),
  sessionId: z.string().max(200).nullish(),
}).passthrough();

// KV keys for playlist data
const KV_PLAYLIST_KEY = 'global-playlist';
const KV_HISTORY_KEY = 'playlist-history';
const MAX_QUEUE_SIZE = 10;

interface PlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedBy?: string;
  addedByName?: string;
  addedAt: string;
}

interface GlobalPlaylist {
  queue: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  lastUpdated: string;
  trackStartedAt?: string | null;
  reactionCount?: number; // Global reaction count, resets per track
}

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
      return ApiErrors.notConfigured('KV storage');
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
    }), { expirationTtl: 86400 });

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
    }), { expirationTtl: 86400 });

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

      const now = new Date().toISOString();

      switch (action) {
        case 'next':
          // Skip current track - remove it and play next user track or autoplay
          if (playlist.queue.length > 0) {
            playlist.queue.shift(); // Remove current track
          }

          if (playlist.queue.length > 0) {
            // Play next user-added track
            playlist.isPlaying = true;
            playlist.trackStartedAt = now;
            playlist.currentIndex = 0;
            // Playing next user track
          } else {
            // Queue empty - pick random track for autoplay
            const nextRandomTrack = await pickRandomFromServerHistory(env);
            if (nextRandomTrack) {
              playlist.queue.push(nextRandomTrack);
              playlist.isPlaying = true;
              playlist.trackStartedAt = now;
              playlist.currentIndex = 0;
              // Autoplay picked next track
            } else {
              playlist.isPlaying = false;
              playlist.trackStartedAt = null;
            }
          }
          break;
        case 'play':
          playlist.isPlaying = true;
          // Set track start time when resuming/starting
          playlist.trackStartedAt = now;
          break;
        case 'pause':
          playlist.isPlaying = false;
          // Clear track start time when paused
          playlist.trackStartedAt = null;
          break;
        case 'toggle':
          playlist.isPlaying = !playlist.isPlaying;
          // Update track start time based on new state
          playlist.trackStartedAt = playlist.isPlaying ? now : null;
          break;
        case 'trackEnded':
          // SERVER picks next track - ensures all clients play the same thing
          // Use trackId to prevent race conditions (multiple clients calling trackEnded)
          const { trackId, finishedTrackTitle } = body;
          const currentTrack = playlist.queue[0];

          // RACE PROTECTION 1: If trackId provided and doesn't match current track, already handled
          if (trackId && currentTrack && currentTrack.id !== trackId) {
            // trackEnded ignored - track already changed
            return successResponse({ alreadyHandled: true,
              playlist });
          }

          // RACE PROTECTION 2: If a new track was started within last 5 seconds, don't pick another
          // This catches cases where multiple clients read old state before any wrote
          const trackJustStarted = playlist.trackStartedAt &&
            (Date.now() - new Date(playlist.trackStartedAt).getTime()) < 5000;
          if (trackJustStarted && playlist.queue.length > 0) {
            // trackEnded ignored - race protection
            return successResponse({ alreadyHandled: true,
              playlist });
          }

          // Save the finished track to recently played before removing
          if (currentTrack) {
            // Use the title from the client if provided (it has the resolved title)
            // Otherwise fall back to the track's title
            const trackTitle = finishedTrackTitle || currentTrack.title;
            await addToRecentlyPlayed({
              ...currentTrack,
              title: trackTitle,
              playedAt: now
            });
          }

          // Remove only the finished track (first in queue)
          // User-added tracks should play next - autoplay only when queue is empty
          if (playlist.queue.length > 0) {
            playlist.queue.shift(); // Remove first item (the one that just ended)
          }

          // If queue still has items (user-added tracks), play them
          if (playlist.queue.length > 0) {
            playlist.isPlaying = true;
            playlist.trackStartedAt = now;
            // Playing next user track
          } else {
            // Queue is empty - pick a random track for autoplay
            const randomTrack = await pickRandomFromServerHistory(env);
            if (randomTrack) {
              playlist.queue.push(randomTrack);
              playlist.isPlaying = true;
              playlist.trackStartedAt = now;
              // Auto-play: picked random track
            } else {
              // No tracks available - stop playback
              playlist.isPlaying = false;
              playlist.trackStartedAt = null;
              // No tracks for auto-play, stopping
            }
          }
          playlist.currentIndex = 0; // Always play from front of queue
          playlist.reactionCount = 0; // Reset reactions for new track
          break;

        case 'react':
          // Increment global reaction count
          playlist.reactionCount = (playlist.reactionCount || 0) + 1;
          // Broadcast emoji animation to all viewers
          const { emoji, sessionId } = body;
          if (emoji) {
            await broadcastEmojiReaction(emoji, sessionId, locals.runtime.env);
          }
          break;

        case 'startAutoPlay':
          // Server picks autoplay track - ensures ALL clients play the SAME track
          // This is called when queue is empty and clients want to start autoplay

          // RACE PROTECTION: If a track was started within last 10 seconds, don't pick new one
          // This prevents multiple clients from racing to pick different tracks
          const recentlyStarted = playlist.trackStartedAt &&
            (Date.now() - new Date(playlist.trackStartedAt).getTime()) < 10000;

          if (playlist.queue.length === 0 && !recentlyStarted) {
            const autoTrack = await pickRandomFromServerHistory(env);
            if (autoTrack) {
              playlist.queue.push(autoTrack);
              playlist.isPlaying = true;
              playlist.trackStartedAt = now;
              playlist.currentIndex = 0;
              playlist.reactionCount = 0;
              // startAutoPlay: picked track
            } else {
              // startAutoPlay: no tracks available
            }
          } else if (playlist.queue.length > 0) {
            // Queue already has items - just ensure it's playing
            playlist.isPlaying = true;
            if (!playlist.trackStartedAt) {
              playlist.trackStartedAt = now;
            }
            // startAutoPlay: queue has items, resuming
          } else {
            // Recently started - just return current state, don't change anything
            // startAutoPlay: race protection
          }
          break;
      }

      playlist.lastUpdated = now;
    }

    // Save to KV
    await kv.put(KV_PLAYLIST_KEY, JSON.stringify({
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null,
      reactionCount: playlist.reactionCount || 0
    }), { expirationTtl: 86400 });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, locals.runtime.env);

    return successResponse({ playlist });
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] PUT error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}

// Cache for KV binding (set during request handling for helper functions)
let kvCache: KVNamespace | null = null;

function setKVCache(kv: KVNamespace) {
  kvCache = kv;
}

// Fetch recently played from history (top 10 items) - USES KV
async function getRecentlyPlayed(): Promise<Record<string, unknown>[]> {
  try {
    if (!kvCache) return [];
    const data = await kvCache.get(KV_HISTORY_KEY, 'json');
    if (data && data.items) {
      return data.items.slice(0, 10);
    }
  } catch (error: unknown) {
    log.warn('[GlobalPlaylist] Could not fetch recently played:', error);
  }
  return [];
}

// Add a track to the recently played list (keeps only last 10) - USES KV
async function addToRecentlyPlayed(track: Record<string, unknown>): Promise<void> {
  try {
    if (!kvCache) {
      // KV not available for history
      return;
    }

    // Always save tracks - UI will fetch real titles async if needed
    if (!track.url) {
      // Skipping recently played - no URL
      return;
    }

    // Get current history from KV
    const data = await kvCache.get(KV_HISTORY_KEY, 'json');
    let items: Record<string, unknown>[] = data?.items || [];

    // Create the history item
    const historyItem = {
      id: track.id,
      url: track.url,
      platform: track.platform,
      embedId: track.embedId,
      title: track.title,
      thumbnail: track.thumbnail,
      addedBy: track.addedBy,
      addedByName: track.addedByName,
      playedAt: track.playedAt || new Date().toISOString()
    };

    // Prepend to list and keep only last 10
    items = [historyItem, ...items.filter(item => item.id !== track.id)].slice(0, 10);

    // Save to KV
    await kvCache.put(KV_HISTORY_KEY, JSON.stringify({
      items,
      lastUpdated: new Date().toISOString()
    }), { expirationTtl: 86400 });
    // Added to recently played
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] Error adding to recently played:', error);
  }
}

// Pick a random track from server-side history for auto-play
// This ensures ALL clients get the SAME track (server is source of truth)
// Local playlist server URL (H: drive MP3s via Cloudflare tunnel)
const LOCAL_PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';
// Fallback thumbnail for audio files without thumbnails
const AUDIO_THUMBNAIL_FALLBACK = '/place-holder.webp';

async function pickRandomFromLocalServer(env?: Record<string, unknown>): Promise<PlaylistItem | null> {
  try {
    const playlistToken = env?.PLAYLIST_ACCESS_TOKEN || import.meta.env.PLAYLIST_ACCESS_TOKEN || '';
    // Trying local playlist server
    const response = await fetchWithTimeout(`${LOCAL_PLAYLIST_SERVER}/random`, {
      headers: { 'Authorization': `Bearer ${playlistToken}` }
    }, 5000);

    if (!response.ok) {
      // Local server returned non-OK
      return null;
    }

    const data = await response.json();
    if (!data.success || !data.track) {
      // Local server has no tracks
      return null;
    }

    const selected = data.track;
    // Random track selected from local server

    const url = `${LOCAL_PLAYLIST_SERVER}${selected.url}`;
    const thumbnail = selected.thumbnail
      ? `${LOCAL_PLAYLIST_SERVER}${selected.thumbnail}`
      : AUDIO_THUMBNAIL_FALLBACK;

    return {
      id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      url: url,
      platform: 'direct',
      title: selected.name,
      thumbnail: thumbnail,
      duration: selected.duration || undefined,
      addedBy: 'system',
      addedByName: 'Auto-Play',
      addedAt: new Date().toISOString()
    };
  } catch (error: unknown) {
    log.warn('[GlobalPlaylist] Local server error:', error);
    return null;
  }
}

async function pickRandomFromServerHistory(env?: Record<string, unknown>): Promise<PlaylistItem | null> {
  // Try local playlist server first (H: drive MP3s)
  const localTrack = await pickRandomFromLocalServer(env);
  if (localTrack) {
    return localTrack;
  }

  // Fallback: pick a random track from KV history
  try {
    if (kvCache) {
      const data = await kvCache.get(KV_HISTORY_KEY, 'json');
      const items = data?.items;
      if (items && items.length > 0) {
        const pick = items[Math.floor(Math.random() * items.length)];
        if (pick.url) {
          // Autoplay fallback from KV history
          return {
            id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
            url: pick.url,
            platform: pick.platform || 'direct',
            embedId: pick.embedId,
            title: pick.title,
            thumbnail: pick.thumbnail,
            addedBy: 'system',
            addedByName: 'Auto-Play',
            addedAt: new Date().toISOString()
          };
        }
      }
    }
  } catch (error: unknown) {
    log.warn('[GlobalPlaylist] KV history fallback error:', error);
  }

  // No tracks available for autoplay
  return null;
}

// Broadcast emoji reaction to all viewers via Pusher
async function broadcastEmojiReaction(emoji: string, sessionId: string, env?: Record<string, unknown>) {
  try {
    const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = env?.PUSHER_CLUSTER || env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      log.warn('[GlobalPlaylist] Pusher not configured, skipping emoji broadcast');
      return;
    }

    // Broadcast to the stream channel (same channel livestream uses)
    const channel = 'stream-playlist-global';
    const event = 'reaction';
    const data = JSON.stringify({
      type: 'emoji',
      emoji: emoji,
      sessionId: sessionId || '',
      timestamp: Date.now()
    });

    // Create Pusher signature
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data });
    const bodyMd5 = simpleMd5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    const pusherResponse = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    // Emoji broadcast sent
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] Emoji broadcast error:', error);
  }
}

// In-memory cache for recently played (reduces KV reads)
let recentlyPlayedCache: { items: Record<string, unknown>[], timestamp: number } | null = null;
const RECENTLY_PLAYED_CACHE_TTL = 10000; // 10 seconds

async function getCachedRecentlyPlayed(): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  if (recentlyPlayedCache && (now - recentlyPlayedCache.timestamp) < RECENTLY_PLAYED_CACHE_TTL) {
    return recentlyPlayedCache.items;
  }
  const items = await getRecentlyPlayed();
  recentlyPlayedCache = { items, timestamp: now };
  return items;
}

// Broadcast playlist update via Pusher (includes recently played)
async function broadcastPlaylistUpdate(playlist: GlobalPlaylist, env?: Record<string, unknown>) {
  try {
    const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = env?.PUSHER_CLUSTER || env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      log.warn('[GlobalPlaylist] Pusher not configured, skipping broadcast');
      return;
    }

    // Use cached recently played to reduce KV reads
    const recentlyPlayed = await getCachedRecentlyPlayed();

    const channel = 'live-playlist';
    const event = 'playlist-update';
    const data = JSON.stringify({ ...playlist, recentlyPlayed });

    // Create Pusher signature
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data });
    const bodyMd5 = simpleMd5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    const pusherResponse = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    const pusherResult = await pusherResponse.text();
    // Playlist broadcast sent
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] Broadcast error:', error);
  }
}

async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
