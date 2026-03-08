// src/pages/api/livestream/status.ts
// Check if any stream is currently live - D1 first, Firebase fallback
// NOW USES CLOUDFLARE CACHE API (FREE & UNLIMITED) instead of KV
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, updateDocument } from '../../../lib/firebase-rest';
import { buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { d1GetLiveSlots, d1GetScheduledSlots, d1GetSlotById } from '../../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { createLogger, successResponse, jsonResponse as sharedJsonResponse } from '../../../lib/api-utils';
import { APPROVED_RELAY_STATIONS, checkStationLive } from '../../../lib/relay-stations';

const log = createLogger('[livestream/status]');

// Cache TTLs in seconds
// Pusher handles real-time updates, so polling can be slower
const CACHE_TTL = {
  LIVE_STATUS: 60,      // 1 min - Pusher handles real-time, this is just backup
  SPECIFIC_STREAM: 60,  // 1 min
  OFFLINE_STATUS: 120,  // 2 min when offline - no urgency
};

// Cache API helpers (FREE and unlimited - replaces KV for reads)
const CACHE_BASE_URL = `${SITE_URL}/__cache/status`;

async function getCached(key: string): Promise<Record<string, unknown> | null> {
  try {
    const cache = caches.default;
    const cacheUrl = `${CACHE_BASE_URL}/${key}`;
    const cached = await cache.match(cacheUrl);
    if (cached) {
      return await cached.json();
    }
  } catch (e: unknown) {
    // Cache API not available (local dev) - continue without cache
  }
  return null;
}

async function setCached(key: string, data: Record<string, unknown>, ttlSeconds: number): Promise<void> {
  try {
    const cache = caches.default;
    const cacheUrl = `${CACHE_BASE_URL}/${key}`;
    const response = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttlSeconds}`,
      }
    });
    await cache.put(cacheUrl, response);
  } catch (e: unknown) {
    // Cache API not available (local dev) - continue without cache
  }
}

// Delete from Cache API - exported for use by other APIs (e.g., slots.ts endStream)
export async function invalidateStatusCache(): Promise<void> {
  try {
    const cache = caches.default;
    // Delete the general status cache
    await cache.delete(`${CACHE_BASE_URL}/general`);
    log.info('Invalidated Cache API status cache');
  } catch (e: unknown) {
    log.info('Cache API delete not available:', e);
  }
}

function jsonResponse(data: Record<string, unknown>, status: number, maxAge: number = 10): Response {
  return sharedJsonResponse(data, status, {
    headers: { 'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge * 2}` }
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`livestream-status:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Red5 env for HLS URL building
  const env = locals.runtime.env;
  const db = env?.DB; // D1 database binding

  initRed5Env({
    RED5_HLS_URL: env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL,
  });

  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const skipCache = url.searchParams.get('fresh') === '1';

    // Specific stream lookup
    if (streamId) {
      const cacheKey = `stream-${streamId}`;

      if (!skipCache) {
        // Check Cache API (FREE - replaces KV)
        const cached = await getCached(cacheKey);
        if (cached) {
          return jsonResponse(cached, cached.success ? 200 : 404, 15);
        }
      }

      // Try D1 first (FREE reads)
      let streamDoc = db ? await d1GetSlotById(db, streamId) : null;

      if (!streamDoc) {
        // Fall back to Firebase
        streamDoc = await getDocument('livestreamSlots', streamId);
      }

      if (!streamDoc) {
        // Fall back to legacy livestreams collection
        streamDoc = await getDocument('livestreams', streamId);
      }

      if (!streamDoc) {
        const result = { success: false, error: 'Stream not found' };
        await setCached(cacheKey, result, CACHE_TTL.SPECIFIC_STREAM);
        return jsonResponse(result, 404, 15);
      }

      // SECURITY: Remove sensitive fields from public response
      const { streamKey, twitchStreamKey, rtmpUrl, ...safeStreamDoc } = streamDoc;

      const result = {
        success: true,
        stream: safeStreamDoc
      };
      await setCached(cacheKey, result, CACHE_TTL.SPECIFIC_STREAM);
      return jsonResponse(result, 200, 15);
    }

    // General live status check
    const statusCacheKey = 'general';

    if (!skipCache) {
      // Check Cache API (FREE - replaces KV)
      const cached = await getCached(statusCacheKey);
      if (cached) {
        const maxAge = cached.isLive ? 10 : 30;
        return jsonResponse(cached, 200, maxAge);
      }
    }

    // Try D1 first for live slots (FREE reads)
    let liveSlots = db ? await d1GetLiveSlots(db) : [];

    // Sanity check: if D1 says live but slot endTime has passed, verify with Firebase
    // D1 sync is fire-and-forget so it can be stale
    const now = new Date();
    if (liveSlots.length > 0) {
      const hasExpiredSlot = liveSlots.some(s => s.endTime && new Date(s.endTime) < now);
      if (hasExpiredSlot || skipCache) {
        // Cross-check with Firebase (source of truth)
        const firebaseLive = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
          limit: 5,
          skipCache: true
        });
        // Use Firebase result — it's always more up to date
        liveSlots = firebaseLive;
      }
    }

    // Fall back to Firebase if D1 returns nothing
    if (liveSlots.length === 0) {
      liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 5,
        cacheTime: 30000 // 30 second cache - Pusher handles real-time updates
      });
    }

    // Convert slots to stream format for the player
    // SECURITY: Do NOT expose streamKey in public response - it would allow stream hijacking
    let liveStreams = liveSlots.map(slot => ({
      id: slot.id,
      slotId: slot.id,
      title: slot.title || `${slot.djName}'s Stream`,
      djName: slot.djName,
      djId: slot.djId,
      djAvatar: slot.djAvatar || '/place-holder.webp',
      genre: slot.genre || 'Jungle / D&B',
      description: slot.description || '',
      isLive: true,
      status: 'live',
      startedAt: slot.liveStartTime || slot.startTime,
      startTime: slot.startTime,
      endTime: slot.endTime,
      duration: slot.duration,
      // Always use stored hlsUrl if available (updated by DJ lobby on mode change)
      // Fall back to buildHlsUrl only if no stored URL AND not a relay stream (relay is audio-only)
      hlsUrl: slot.hlsUrl || (!slot.isRelay && slot.streamKey ? buildHlsUrl(slot.streamKey) : null),
      broadcastMode: slot.broadcastMode || 'video',
      // streamKey intentionally omitted - security risk
      streamSource: slot.isRelay ? 'relay' : 'red5',
      isRelay: slot.isRelay || false,
      relaySource: slot.relaySource || null,
      audioStreamUrl: slot.audioStreamUrl || (slot.isRelay && slot.relaySource?.url) || null,
      youtubeLiveId: slot.youtubeLiveId || null,
      twitchChannel: slot.twitchChannel || slot.twitchUsername || null,
      currentViewers: slot.currentViewers || 0,
      totalViews: slot.totalViews || 0,
      totalLikes: slot.totalLikes || 0,
      averageRating: slot.averageRating || 0,
      coverImage: slot.coverImage || '/place-holder.webp',
    }));

    // Also check legacy livestreams collection
    if (liveStreams.length === 0) {
      const legacyStreams = await queryCollection('livestreams', {
        filters: [{ field: 'isLive', op: 'EQUAL', value: true }],
        limit: 5,
        cacheTime: 30000 // 30 second cache
      });
      liveStreams = legacyStreams;
    }

    if (liveStreams.length === 0) {
      // Check for scheduled streams
      const now = new Date().toISOString();

      // Try D1 first for scheduled slots (FREE reads)
      let scheduledSlots = db ? await d1GetScheduledSlots(db, now) : [];

      // Fall back to Firebase if D1 returns nothing
      if (scheduledSlots.length === 0) {
        scheduledSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'scheduled' }],
          limit: 10,
          cacheTime: 300000 // 5 minute cache - scheduled streams don't change often
        });
      }

      const scheduled = scheduledSlots
        .filter(s => s.startTime && s.startTime > now)
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
        .slice(0, 3)
        .map(s => ({
          id: s.id,
          title: s.title || `${s.djName}'s Stream`,
          djName: s.djName,
          scheduledFor: s.startTime,
          genre: s.genre,
        }));

      const result = {
        success: true,
        isLive: false,
        streams: [],
        scheduled
      };

      // Cache offline status (Cache API - FREE)
      await setCached(statusCacheKey, result, CACHE_TTL.OFFLINE_STATUS);

      return jsonResponse(result, 200, 30);
    }

    // For relay streams: refresh metadata from the station every 5 minutes
    // The Shoutcast `song` field contains the current DJ/show name (e.g. "BSOD - Introspection Sessions")
    // The `servertitle` field is just the static station name (e.g. "THE UNDERGROUND LAIR STREAM")
    for (const stream of liveStreams) {
      if (!stream.isRelay || !stream.relaySource?.url) continue;

      // Check if we should refresh (every 5 minutes, keyed by slot ID)
      const relayCacheKey = `relay-meta-${stream.id}`;
      const cachedMeta = await getCached(relayCacheKey);
      if (cachedMeta) {
        // Use cached relay metadata
        stream.relayNowPlaying = cachedMeta.nowPlaying as string || undefined;
        stream.relayServerTitle = cachedMeta.serverTitle as string || undefined;
        if (cachedMeta.nowPlaying) {
          stream.title = cachedMeta.nowPlaying as string;
        }
        continue;
      }

      // Fetch fresh metadata from the station
      const station = APPROVED_RELAY_STATIONS.find(s =>
        s.streamUrl === stream.relaySource.url || s.httpsStreamUrl === stream.relaySource.url
      );
      if (!station) continue;

      try {
        const stationStatus = await checkStationLive(station);
        const meta = {
          nowPlaying: stationStatus.nowPlaying || '',
          serverTitle: stationStatus.serverTitle || '',
          listeners: stationStatus.listeners || 0
        };

        // Cache for 5 minutes
        await setCached(relayCacheKey, meta, 300);

        stream.relayNowPlaying = stationStatus.nowPlaying;
        stream.relayServerTitle = stationStatus.serverTitle;

        // Use the song/now-playing field as the title (contains DJ/show name)
        // servertitle is just the static station name
        if (stationStatus.nowPlaying && stationStatus.nowPlaying !== stream.title) {
          stream.title = stationStatus.nowPlaying;
          // Fire-and-forget: update Firestore slot title so it persists
          updateDocument('livestreamSlots', stream.id as string, {
            title: stationStatus.nowPlaying,
            updatedAt: new Date().toISOString()
          }).catch(() => {});
          // Invalidate status cache so next poll sees the update
          await invalidateStatusCache();
        }
      } catch (e: unknown) {
        log.warn('Failed to refresh relay metadata:', e);
      }
    }

    // Sort by startedAt desc
    const streams = liveStreams.sort((a, b) => {
      const dateA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const dateB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return dateB - dateA;
    });

    const result = {
      success: true,
      isLive: true,
      streams,
      primaryStream: streams[0]
    };

    // Cache live status (Cache API - FREE)
    await setCached(statusCacheKey, result, CACHE_TTL.LIVE_STATUS);

    return jsonResponse(result, 200, 10);

  } catch (error: unknown) {
    log.error('Error:', error);
    return jsonResponse({
      success: false,
      error: 'Failed to get stream status'
    }, 500, 5);
  }
};
