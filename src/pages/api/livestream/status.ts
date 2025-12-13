// src/pages/api/livestream/status.ts
// Check if any stream is currently live - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../../lib/firebase-rest';

// Server-side cache
interface CacheEntry {
  data: any;
  timestamp: number;
}

const statusCache = new Map<string, CacheEntry>();
const CACHE_TTL = {
  LIVE_STATUS: 10 * 1000,
  SPECIFIC_STREAM: 15 * 1000,
  OFFLINE_STATUS: 30 * 1000,
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

export const GET: APIRoute = async ({ request }) => {
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

      const streamDoc = await getDocument('livestreams', streamId);

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

    // Check for any live stream
    const liveStreams = await queryCollection('livestreams', {
      filters: [{ field: 'isLive', op: 'EQUAL', value: true }],
      limit: 5,
      skipCache: true
    });

    if (liveStreams.length === 0) {
      // Check for scheduled streams
      const now = new Date().toISOString();
      const allStreams = await queryCollection('livestreams', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'scheduled' }],
        limit: 10,
        skipCache: true
      });

      const scheduled = allStreams
        .filter(s => s.scheduledFor && s.scheduledFor > now)
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
        .slice(0, 3);

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
