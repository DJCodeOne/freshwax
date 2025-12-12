// src/pages/api/livestream/status.ts
// Check if any stream is currently live and get stream details
// OPTIMIZED: Server-side caching to reduce Firebase reads

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// ==========================================
// SERVER-SIDE CACHE - Reduces Firebase reads
// ==========================================
interface CacheEntry {
  data: any;
  timestamp: number;
}

const statusCache = new Map<string, CacheEntry>();
const CACHE_TTL = {
  LIVE_STATUS: 10 * 1000,      // 10 seconds for general status (polled frequently)
  SPECIFIC_STREAM: 15 * 1000,  // 15 seconds for specific stream lookups
  OFFLINE_STATUS: 30 * 1000,   // 30 seconds when offline (less urgent)
};

function getCached(key: string): any | null {
  const entry = statusCache.get(key);
  if (entry && Date.now() - entry.timestamp < getCacheTTL(key)) {
    return entry.data;
  }
  if (entry) statusCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  statusCache.set(key, { data, timestamp: Date.now() });
  // Prune old entries if cache grows
  if (statusCache.size > 20) {
    const oldest = statusCache.keys().next().value;
    if (oldest) statusCache.delete(oldest);
  }
}

function getCacheTTL(key: string): number {
  if (key.startsWith('stream:')) return CACHE_TTL.SPECIFIC_STREAM;
  if (key === 'status:offline') return CACHE_TTL.OFFLINE_STATUS;
  return CACHE_TTL.LIVE_STATUS;
}

// Helper to create response with proper cache headers
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
    
    // ==========================================
    // SPECIFIC STREAM LOOKUP
    // ==========================================
    if (streamId) {
      const cacheKey = `stream:${streamId}`;
      
      // Check cache first
      if (!skipCache) {
        const cached = getCached(cacheKey);
        if (cached) {
          return jsonResponse(cached, cached.success ? 200 : 404, 15);
        }
      }
      
      const streamDoc = await db.collection('livestreams').doc(streamId).get();
      
      if (!streamDoc.exists) {
        const result = { success: false, error: 'Stream not found' };
        setCache(cacheKey, result);
        return jsonResponse(result, 404, 15);
      }
      
      const result = {
        success: true,
        stream: { id: streamDoc.id, ...streamDoc.data() }
      };
      setCache(cacheKey, result);
      return jsonResponse(result, 200, 15);
    }
    
    // ==========================================
    // GENERAL LIVE STATUS CHECK
    // ==========================================
    const statusCacheKey = 'status:general';
    
    // Check cache first
    if (!skipCache) {
      const cached = getCached(statusCacheKey);
      if (cached) {
        const maxAge = cached.isLive ? 10 : 30;
        return jsonResponse(cached, 200, maxAge);
      }
    }
    
    // Check for any live stream
    const liveStreams = await db.collection('livestreams')
      .where('isLive', '==', true)
      .orderBy('startedAt', 'desc')
      .limit(5)
      .get();
    
    if (liveStreams.empty) {
      // Check for scheduled streams
      const now = new Date().toISOString();
      const scheduledStreams = await db.collection('livestreams')
        .where('status', '==', 'scheduled')
        .where('scheduledFor', '>', now)
        .orderBy('scheduledFor', 'asc')
        .limit(3)
        .get();
      
      const scheduled = scheduledStreams.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      const result = {
        success: true,
        isLive: false,
        streams: [],
        scheduled
      };
      
      // Cache offline status longer (30 seconds)
      statusCache.set('status:offline', { data: result, timestamp: Date.now() });
      setCache(statusCacheKey, result);
      
      return jsonResponse(result, 200, 30);
    }
    
    const streams = liveStreams.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    const result = {
      success: true,
      isLive: true,
      streams,
      primaryStream: streams[0]
    };
    
    setCache(statusCacheKey, result);
    
    // Shorter cache when live (10 seconds) for responsiveness
    return jsonResponse(result, 200, 10);
    
  } catch (error) {
    console.error('[livestream/status] Error:', error);
    return jsonResponse({
      success: false,
      error: 'Failed to get stream status'
    }, 500, 5);
  }
};
