// src/lib/dj-mixes.ts
// Server-side DJ mixes helper - uses Firebase Admin directly during SSR
// OPTIMIZED: Server-side caching to reduce Firebase reads

import { db } from '../firebase/server';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// ==========================================
// SERVER-SIDE CACHE - Reduces Firebase reads
// ==========================================
interface CacheEntry {
  data: any;
  expires: number;
  fetchedAt: number;
}

const mixesCache = new Map<string, CacheEntry>();

const CACHE_TTL = {
  ALL_MIXES: 30 * 60 * 1000,     // 30 minutes for all mixes
  SINGLE_MIX: 30 * 60 * 1000,   // 30 minutes for individual mixes
  BY_DJ: 15 * 60 * 1000,        // 15 minutes for DJ queries
};

function getCached(key: string): any | null {
  const entry = mixesCache.get(key);
  if (entry && Date.now() < entry.expires) {
    log.info(`[dj-mixes] Cache HIT: ${key} (age: ${Math.round((Date.now() - entry.fetchedAt) / 1000)}s)`);
    return entry.data;
  }
  if (entry) {
    mixesCache.delete(key);
    log.info(`[dj-mixes] Cache EXPIRED: ${key}`);
  }
  return null;
}

function setCache(key: string, data: any, ttl: number): void {
  mixesCache.set(key, {
    data,
    expires: Date.now() + ttl,
    fetchedAt: Date.now()
  });
  log.info(`[dj-mixes] Cache SET: ${key} (TTL: ${ttl / 1000}s, cache size: ${mixesCache.size})`);
  
  // Prune if cache grows too large
  if (mixesCache.size > 50) {
    const oldest = mixesCache.keys().next().value;
    if (oldest) mixesCache.delete(oldest);
  }
}

// Export for manual cache invalidation
export function invalidateMixesCache(pattern?: string): void {
  if (pattern) {
    let cleared = 0;
    for (const key of mixesCache.keys()) {
      if (key.includes(pattern)) {
        mixesCache.delete(key);
        cleared++;
      }
    }
    log.info(`[dj-mixes] Cache invalidated: ${cleared} entries matching "${pattern}"`);
  } else {
    mixesCache.clear();
    log.info('[dj-mixes] Cache cleared: all entries');
  }
}

// Helper function to normalize mix data
function normalizeMix(doc: FirebaseFirestore.DocumentSnapshot): any {
  const data = doc.data();
  if (!data) return null;
  
  return {
    id: doc.id,
    title: data.title || data.name || 'Untitled Mix',
    // Prioritize displayName for public views, fall back to dj_name/djName
    dj_name: data.displayName || data.dj_name || data.djName || data.artist || 'Unknown DJ',
    artwork_url: data.artwork_url || data.artworkUrl || data.coverUrl || data.imageUrl || '/place-holder.webp',
    audio_url: data.audio_url || data.audioUrl || data.mp3Url || data.streamUrl || null,
    duration: data.duration || null,
    durationSeconds: data.durationSeconds || data.duration_seconds || null,
    genre: data.genre || data.genres || 'Jungle & D&B',
    description: data.description || '',
    plays: data.playCount || data.plays || 0,
    likes: data.likeCount || data.likes || 0,
    downloads: data.downloadCount || data.downloads || 0,
    commentCount: data.commentCount || (data.comments?.length || 0),
    upload_date: data.upload_date || data.uploadedAt || data.createdAt || new Date().toISOString(),
    published: data.published ?? data.status === 'live' ?? true,
    // Include original data for any additional fields
    ...data
  };
}

// Get all published DJ mixes
export async function getDJMixesForPage(limit: number = 50): Promise<any[]> {
  if (!db) {
    console.warn('[getDJMixesForPage] Firebase not initialized');
    return [];
  }
  
  // Check cache first
  const cacheKey = `mixes-page:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    log.info(`[getDJMixesForPage] Fetching up to ${limit} mixes from Firebase...`);
    
    // Try 'published' field first
    let snapshot = await db.collection('dj-mixes')
      .where('published', '==', true)
      .limit(limit)
      .get();
    
    // If no results, try 'status' field
    if (snapshot.empty) {
      snapshot = await db.collection('dj-mixes')
        .where('status', '==', 'live')
        .limit(limit)
        .get();
    }
    
    // If still no results, get all (for backwards compatibility)
    if (snapshot.empty) {
      snapshot = await db.collection('dj-mixes')
        .limit(limit)
        .get();
    }
    
    const mixes: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeMix(doc);
      if (normalized) {
        mixes.push(normalized);
      }
    });
    
    // Sort by upload date (newest first)
    mixes.sort((a, b) => {
      const dateA = new Date(a.upload_date || 0).getTime();
      const dateB = new Date(b.upload_date || 0).getTime();
      return dateB - dateA;
    });
    
    log.info(`[getDJMixesForPage] ✓ Fetched ${mixes.length} mixes`);
    
    // Cache the results
    setCache(cacheKey, mixes, CACHE_TTL.ALL_MIXES);
    
    return mixes;
    
  } catch (error) {
    console.error('[getDJMixesForPage] Error:', error);
    return [];
  }
}

// Get single DJ mix by ID
export async function getDJMixById(mixId: string): Promise<any | null> {
  if (!db) {
    console.warn('[getDJMixById] Firebase not initialized');
    return null;
  }
  
  // Check cache first
  const cacheKey = `mix:${mixId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  // Also check if it's in the all-mixes cache
  const allCached = getCached('mixes-page:50');
  if (allCached) {
    const found = allCached.find((m: any) => m.id === mixId);
    if (found) {
      log.info(`[getDJMixById] Found ${mixId} in all-mixes cache`);
      setCache(cacheKey, found, CACHE_TTL.SINGLE_MIX);
      return found;
    }
  }
  
  try {
    log.info(`[getDJMixById] Fetching from Firebase: ${mixId}`);
    const doc = await db.collection('dj-mixes').doc(mixId).get();
    
    if (!doc.exists) {
      log.info(`[getDJMixById] ✗ Not found: ${mixId}`);
      return null;
    }
    
    const normalized = normalizeMix(doc);
    log.info(`[getDJMixById] ✓ Found: ${normalized?.title}`);
    
    // Cache the result
    if (normalized) {
      setCache(cacheKey, normalized, CACHE_TTL.SINGLE_MIX);
    }
    
    return normalized;
    
  } catch (error) {
    console.error('[getDJMixById] Error:', error);
    return null;
  }
}

// Get mixes by DJ name
export async function getDJMixesByDJ(djName: string, limit: number = 20): Promise<any[]> {
  if (!db) return [];
  
  // Check cache first
  const cacheKey = `mixes-by-dj:${djName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    // Try to use the all-mixes cache first (avoids extra Firebase read)
    const allCached = getCached('mixes-page:50');
    if (allCached) {
      const filtered = allCached
        .filter((m: any) => 
          (m.dj_name?.toLowerCase() === djName.toLowerCase()) ||
          (m.djName?.toLowerCase() === djName.toLowerCase()) ||
          (m.artist?.toLowerCase() === djName.toLowerCase())
        )
        .sort((a: any, b: any) => {
          const dateA = new Date(a.upload_date || 0).getTime();
          const dateB = new Date(b.upload_date || 0).getTime();
          return dateB - dateA;
        })
        .slice(0, limit);
      
      log.info(`[getDJMixesByDJ] Found ${filtered.length} mixes for "${djName}" from cache`);
      setCache(cacheKey, filtered, CACHE_TTL.BY_DJ);
      return filtered;
    }
    
    // Fall back to Firebase query
    const snapshot = await db.collection('dj-mixes')
      .where('dj_name', '==', djName)
      .limit(limit)
      .get();
    
    const mixes: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeMix(doc);
      if (normalized) {
        mixes.push(normalized);
      }
    });
    
    mixes.sort((a, b) => {
      const dateA = new Date(a.upload_date || 0).getTime();
      const dateB = new Date(b.upload_date || 0).getTime();
      return dateB - dateA;
    });
    
    log.info(`[getDJMixesByDJ] Found ${mixes.length} mixes for "${djName}"`);
    
    // Cache the results
    setCache(cacheKey, mixes, CACHE_TTL.BY_DJ);
    
    return mixes;
    
  } catch (error) {
    console.error('[getDJMixesByDJ] Error:', error);
    return [];
  }
}