// src/pages/api/livestream/status.ts
// Check if any stream is currently live - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../../lib/firebase-rest';
import { buildHlsUrl, initRed5Env } from '../../../lib/red5';

// Server-side cache
interface CacheEntry {
  data: any;
  timestamp: number;
}

const statusCache = new Map<string, CacheEntry>();
const CACHE_TTL = {
  LIVE_STATUS: 30 * 1000,      // Increased from 10s to 30s
  SPECIFIC_STREAM: 30 * 1000,  // Increased from 15s to 30s
  OFFLINE_STATUS: 60 * 1000,   // Increased from 30s to 60s
};

function getCached(key: string): any | null {
  const entry = statusCache.get(key);
  const ttl = key.startsWith('stream:') ? CACHE_TTL.SPECIFIC_STREAM :
              key === 'status:offline' ? CACHE_TTL.OFFLINE_STATUS : CACHE_TTL.LIVE_STATUS;
  if (entry && Date.now() - entry.timestamp < ttl) {
    return entry.data;
  }
  if (entry) statusCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  statusCache.set(key, { data, timestamp: Date.now() });
  if (statusCache.size > 20) {
    const oldest = statusCache.keys().next().value;
    if (oldest) statusCache.delete(oldest);
  }
}

function jsonResponse(data: any, status: number, maxAge: number = 10): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge * 2}`,
    }
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Red5 env for HLS URL building
  const env = (locals as any)?.runtime?.env;
  initRed5Env({
    RED5_HLS_URL: env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL,
  });

  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const skipCache = url.searchParams.get('fresh') === '1';

    // Specific stream lookup
    if (streamId) {
      const cacheKey = `stream:${streamId}`;

      if (!skipCache) {
        const cached = getCached(cacheKey);
        if (cached) {
          return jsonResponse(cached, cached.success ? 200 : 404, 15);
        }
      }

      // Check livestreamSlots first (slot-based streams)
      let streamDoc = await getDocument('livestreamSlots', streamId);

      if (!streamDoc) {
        // Fall back to legacy livestreams collection
        streamDoc = await getDocument('livestreams', streamId);
      }

      if (!streamDoc) {
        const result = { success: false, error: 'Stream not found' };
        setCache(cacheKey, result);
        return jsonResponse(result, 404, 15);
      }

      const result = {
        success: true,
        stream: streamDoc
      };
      setCache(cacheKey, result);
      return jsonResponse(result, 200, 15);
    }

    // General live status check
    const statusCacheKey = 'status:general';

    if (!skipCache) {
      const cached = getCached(statusCacheKey);
      if (cached) {
        const maxAge = cached.isLive ? 10 : 30;
        return jsonResponse(cached, 200, maxAge);
      }
    }

    // Check livestreamSlots for slots with status='live' (new slot-based system)
    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 5
      // Removed skipCache: true - use cached data to reduce Firebase reads
    });

    // Convert slots to stream format for the player
    let liveStreams = liveSlots.map(slot => ({
      id: slot.id,
      title: slot.title || `${slot.djName}'s Stream`,
      djName: slot.djName,
      djId: slot.djId,
      djAvatar: slot.djAvatar || '/placeholder.webp',
      genre: slot.genre || 'Jungle / D&B',
      description: slot.description || '',
      isLive: true,
      status: 'live',
      startedAt: slot.liveStartTime || slot.startTime,
      // Always use stored hlsUrl if available (updated by DJ lobby on mode change)
      // Fall back to buildHlsUrl only if no stored URL
      hlsUrl: slot.hlsUrl || (slot.streamKey ? buildHlsUrl(slot.streamKey) : null),
      broadcastMode: slot.broadcastMode || 'video',
      streamKey: slot.streamKey,
      streamSource: 'red5',
      currentViewers: slot.currentViewers || 0,
      totalViews: slot.totalViews || 0,
      totalLikes: slot.totalLikes || 0,
      averageRating: slot.averageRating || 0,
      coverImage: slot.coverImage || '/placeholder.webp',
    }));

    // Also check legacy livestreams collection
    if (liveStreams.length === 0) {
      const legacyStreams = await queryCollection('livestreams', {
        filters: [{ field: 'isLive', op: 'EQUAL', value: true }],
        limit: 5
        // Removed skipCache: true - use cached data to reduce Firebase reads
      });
      liveStreams = legacyStreams;
    }

    if (liveStreams.length === 0) {
      // Check for scheduled streams
      const now = new Date().toISOString();

      // Check scheduled slots
      const scheduledSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'scheduled' }],
        limit: 10
        // Removed skipCache: true - use cached data to reduce Firebase reads
      });

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

      statusCache.set('status:offline', { data: result, timestamp: Date.now() });
      setCache(statusCacheKey, result);

      return jsonResponse(result, 200, 30);
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

    setCache(statusCacheKey, result);

    return jsonResponse(result, 200, 10);

  } catch (error) {
    console.error('[livestream/status] Error:', error);
    return jsonResponse({
      success: false,
      error: 'Failed to get stream status'
    }, 500, 5);
  }
};
