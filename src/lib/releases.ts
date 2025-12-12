// src/lib/releases.ts
// Uses Firebase Admin directly during SSR
// OPTIMIZED: Server-side caching to reduce Firebase reads significantly

import { db } from '../firebase/server';

// Conditional logging - only logs in development
const isDev = import.meta.env?.DEV ?? false;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// ==========================================
// SERVER-SIDE CACHE - Critical for quota management
// ==========================================
interface CacheEntry {
  data: any;
  expires: number;
  fetchedAt: number;
}

const releasesCache = new Map<string, CacheEntry>();

const CACHE_TTL = {
  ALL_RELEASES: 30 * 60 * 1000,     // 30 minutes for all releases
  SINGLE_RELEASE: 30 * 60 * 1000,   // 30 minutes for individual releases
  BY_ARTIST: 15 * 60 * 1000,        // 15 minutes for artist queries
  BY_LABEL: 15 * 60 * 1000,         // 15 minutes for label queries
  GROUPED: 30 * 60 * 1000,          // 30 minutes for grouped data
};

function getCached(key: string): any | null {
  const entry = releasesCache.get(key);
  if (entry && Date.now() < entry.expires) {
    log.info(`[releases] Cache HIT: ${key} (age: ${Math.round((Date.now() - entry.fetchedAt) / 1000)}s)`);
    return entry.data;
  }
  if (entry) {
    releasesCache.delete(key);
    log.info(`[releases] Cache EXPIRED: ${key}`);
  }
  return null;
}

function setCache(key: string, data: any, ttl: number): void {
  releasesCache.set(key, {
    data,
    expires: Date.now() + ttl,
    fetchedAt: Date.now()
  });
  log.info(`[releases] Cache SET: ${key} (TTL: ${ttl / 1000}s, cache size: ${releasesCache.size})`);
  
  // Prune if cache grows too large
  if (releasesCache.size > 100) {
    pruneCache();
  }
}

function pruneCache(): void {
  const now = Date.now();
  let pruned = 0;
  for (const [key, entry] of releasesCache) {
    if (now >= entry.expires) {
      releasesCache.delete(key);
      pruned++;
    }
  }
  log.info(`[releases] Cache PRUNED: ${pruned} entries removed, ${releasesCache.size} remaining`);
}

// Export for manual cache invalidation (call after updates)
export function invalidateReleasesCache(pattern?: string): void {
  if (pattern) {
    let cleared = 0;
    for (const key of releasesCache.keys()) {
      if (key.includes(pattern)) {
        releasesCache.delete(key);
        cleared++;
      }
    }
    log.info(`[releases] Cache invalidated: ${cleared} entries matching "${pattern}"`);
  } else {
    releasesCache.clear();
    log.info('[releases] Cache cleared: all entries');
  }
}

// Helper function to get label from release data
function getLabelFromRelease(release: any): string {
  return release.labelName || 
         release.label || 
         release.recordLabel || 
         release.copyrightHolder || 
         'Unknown Label';
}

// Helper function to normalize ratings data
function normalizeRatings(data: any): { average: number; count: number; total: number } {
  const ratings = data.ratings || data.overallRating || {};
  
  return {
    average: Number(ratings.average) || 0,
    count: Number(ratings.count) || 0,
    total: Number(ratings.total) || 0
  };
}

// Helper function to normalize a single release document
function normalizeRelease(doc: FirebaseFirestore.DocumentSnapshot): any {
  const data = doc.data();
  if (!data) return null;
  
  return {
    id: doc.id,
    ...data,
    label: getLabelFromRelease(data),
    ratings: normalizeRatings(data),
    tracks: (data.tracks || []).map((track: any, index: number) => ({
      ...track,
      trackNumber: track.trackNumber || track.displayTrackNumber || (index + 1),
      displayTrackNumber: track.displayTrackNumber || track.trackNumber || (index + 1),
      previewUrl: track.previewUrl || track.preview_url || track.mp3Url || null,
      duration: track.duration || null,
      ratings: track.ratings ? {
        average: Number(track.ratings.average) || 0,
        count: Number(track.ratings.count) || 0,
        total: Number(track.ratings.total) || 0
      } : undefined
    }))
  };
}

export async function getAllReleases(): Promise<any[]> {
  if (!db) {
    console.warn('[getAllReleases] Firebase not initialized');
    return [];
  }
  
  // Check cache first
  const cacheKey = 'all-releases';
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    const snapshot = await db.collection('releases')
      .where('status', '==', 'live')
      .get();
    
    const releases: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeRelease(doc);
      if (normalized) {
        releases.push(normalized);
      }
    });
    
    log.info(`[getAllReleases] Fetched ${releases.length} releases from Firebase`);
    
    if (releases.length > 0) {
      log.info('[getAllReleases] First release:', {
        id: releases[0].id,
        label: releases[0].label,
        ratings: releases[0].ratings,
        trackCount: releases[0].tracks?.length || 0
      });
    }
    
    // Cache the results
    setCache(cacheKey, releases, CACHE_TTL.ALL_RELEASES);
    
    return releases;
  } catch (error) {
    console.error('[getAllReleases] Error:', error);
    return [];
  }
}

export async function getReleasesForPage(limit: number = 20): Promise<any[]> {
  if (!db) {
    console.warn('[getReleasesForPage] Firebase not initialized');
    return [];
  }
  
  // Check cache first - use limit-specific key
  const cacheKey = `releases-page:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    const snapshot = await db.collection('releases')
      .where('status', '==', 'live')
      .orderBy('releaseDate', 'desc')
      .limit(limit)
      .get();
    
    const releases: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeRelease(doc);
      if (normalized) {
        releases.push(normalized);
      }
    });
    
    log.info(`[getReleasesForPage] Fetched ${releases.length} releases (limit: ${limit})`);
    
    // Cache the results
    setCache(cacheKey, releases, CACHE_TTL.ALL_RELEASES);
    
    return releases;
    
  } catch (error) {
    console.warn('[getReleasesForPage] Indexed query failed, falling back to getAllReleases:', error);
    const all = await getAllReleases();
    const sorted = all
      .sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime())
      .slice(0, limit);
    
    // Cache the fallback results too
    setCache(cacheKey, sorted, CACHE_TTL.ALL_RELEASES);
    
    return sorted;
  }
}

export async function getReleaseById(id: string): Promise<any | null> {
  if (!db) {
    console.warn('[getReleaseById] Firebase not initialized');
    return null;
  }
  
  // Check cache first
  const cacheKey = `release:${id}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  // Also check if it's in the all-releases cache
  const allCached = getCached('all-releases');
  if (allCached) {
    const found = allCached.find((r: any) => r.id === id);
    if (found) {
      log.info(`[getReleaseById] Found ${id} in all-releases cache`);
      setCache(cacheKey, found, CACHE_TTL.SINGLE_RELEASE);
      return found;
    }
  }
  
  try {
    log.info(`[getReleaseById] Fetching from Firebase: ${id}`);
    const doc = await db.collection('releases').doc(id).get();
    
    if (!doc.exists) {
      log.info(`[getReleaseById] ✗ Not found: ${id}`);
      return null;
    }
    
    const data = doc.data();
    log.info(`[getReleaseById] Found, status: ${data?.status}`);
    
    if (!data || data.status !== 'live') {
      log.info(`[getReleaseById] ✗ Status not live: ${id}`);
      return null;
    }
    
    const result = normalizeRelease(doc);
    
    log.info(`[getReleaseById] ✓ Returning:`, {
      id: result.id,
      artistName: result.artistName,
      releaseName: result.releaseName,
      label: result.label,
      ratings: result.ratings,
      coverArtUrl: result.coverArtUrl?.substring(0, 50)
    });
    
    // Cache the result
    setCache(cacheKey, result, CACHE_TTL.SINGLE_RELEASE);
    
    return result;
  } catch (error) {
    console.error(`[getReleaseById] Error:`, error);
    return null;
  }
}

export async function getReleasesGroupedByLabel(): Promise<Record<string, any[]>> {
  if (!db) {
    console.warn('[getReleasesGroupedByLabel] Firebase not initialized');
    return {};
  }
  
  // Check cache first
  const cacheKey = 'releases-grouped-by-label';
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    log.info('[getReleasesGroupedByLabel] Fetching and grouping releases');
    const releases = await getAllReleases(); // This now uses cache
    const releasesByLabel: Record<string, any[]> = {};
    
    releases.forEach(release => {
      const label = release.label || getLabelFromRelease(release);
      
      if (!releasesByLabel[label]) {
        releasesByLabel[label] = [];
      }
      releasesByLabel[label].push(release);
    });
    
    Object.keys(releasesByLabel).forEach(label => {
      releasesByLabel[label].sort((a, b) => {
        const dateA = new Date(a.releaseDate || 0).getTime();
        const dateB = new Date(b.releaseDate || 0).getTime();
        return dateB - dateA;
      });
    });
    
    log.info(`[getReleasesGroupedByLabel] ✓ Grouped ${releases.length} releases into ${Object.keys(releasesByLabel).length} labels`);
    
    Object.keys(releasesByLabel).forEach(label => {
      log.info(`  - ${label}: ${releasesByLabel[label].length} releases`);
    });
    
    // Cache the grouped result
    setCache(cacheKey, releasesByLabel, CACHE_TTL.GROUPED);
    
    return releasesByLabel;
  } catch (error) {
    console.error('[getReleasesGroupedByLabel] Error:', error);
    return {};
  }
}

export async function getReleasesByArtist(artistName: string): Promise<any[]> {
  if (!db) return [];
  
  // Check cache first
  const cacheKey = `releases-by-artist:${artistName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    // Try to use the all-releases cache first (avoids extra Firebase read)
    const allCached = getCached('all-releases');
    if (allCached) {
      const filtered = allCached
        .filter((r: any) => r.artistName?.toLowerCase() === artistName.toLowerCase())
        .sort((a: any, b: any) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
      
      log.info(`[getReleasesByArtist] Found ${filtered.length} releases for "${artistName}" from cache`);
      setCache(cacheKey, filtered, CACHE_TTL.BY_ARTIST);
      return filtered;
    }
    
    // Fall back to Firebase query
    const snapshot = await db.collection('releases')
      .where('status', '==', 'live')
      .where('artistName', '==', artistName)
      .get();
    
    const releases: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeRelease(doc);
      if (normalized) {
        releases.push(normalized);
      }
    });
    
    releases.sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
    
    log.info(`[getReleasesByArtist] Found ${releases.length} releases for "${artistName}"`);
    
    // Cache the results
    setCache(cacheKey, releases, CACHE_TTL.BY_ARTIST);
    
    return releases;
  } catch (error) {
    console.error('[getReleasesByArtist] Error:', error);
    return [];
  }
}

export async function getReleasesByLabel(labelName: string): Promise<any[]> {
  if (!db) return [];
  
  // Check cache first
  const cacheKey = `releases-by-label:${labelName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    // OPTIMIZED: Use all-releases cache and filter locally instead of 3 Firebase queries
    const allCached = getCached('all-releases');
    if (allCached) {
      const filtered = allCached.filter((release: any) => {
        const releaseLabel = release.labelName || release.recordLabel || release.copyrightHolder || '';
        return releaseLabel.toLowerCase() === labelName.toLowerCase();
      }).sort((a: any, b: any) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
      
      log.info(`[getReleasesByLabel] Found ${filtered.length} releases for "${labelName}" from cache`);
      setCache(cacheKey, filtered, CACHE_TTL.BY_LABEL);
      return filtered;
    }
    
    // Fall back to Firebase queries (3 parallel queries for different label fields)
    const queries = [
      db.collection('releases').where('status', '==', 'live').where('labelName', '==', labelName).get(),
      db.collection('releases').where('status', '==', 'live').where('recordLabel', '==', labelName).get(),
      db.collection('releases').where('status', '==', 'live').where('copyrightHolder', '==', labelName).get()
    ];
    
    const snapshots = await Promise.all(queries);
    const releaseMap = new Map<string, any>();
    
    snapshots.forEach(snapshot => {
      snapshot.forEach(doc => {
        if (!releaseMap.has(doc.id)) {
          const normalized = normalizeRelease(doc);
          if (normalized) {
            releaseMap.set(doc.id, normalized);
          }
        }
      });
    });
    
    const releases = Array.from(releaseMap.values());
    releases.sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
    
    log.info(`[getReleasesByLabel] Found ${releases.length} releases for "${labelName}"`);
    
    // Cache the results
    setCache(cacheKey, releases, CACHE_TTL.BY_LABEL);
    
    return releases;
  } catch (error) {
    console.error('[getReleasesByLabel] Error:', error);
    return [];
  }
}