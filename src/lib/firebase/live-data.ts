// src/lib/firebase/live-data.ts
// Optimized live data fetchers with D1 primary + Firebase fallback + tiered caching
// Functions: getLiveReleases, getLiveDJMixes, getLiveMerch, extractTracksFromReleases, shuffleArray

import { kvCacheThrough, CACHE_CONFIG } from '../kv-cache';
import {
  log,
  CACHE_TTL,
  getCached,
  setCache,
} from './core';
import { queryCollection } from './queries';

// ==========================================
// OPTIMIZED HELPER FUNCTIONS
// ==========================================

// Get releases with extended cache for quota optimization
// Now supports D1 as primary source with Firebase fallback
// Cache tiers: 1) in-memory (~0ms) -> 2) KV (~30ms) -> 3) D1/Firebase (~300-900ms)
export async function getLiveReleases(limit?: number, db?: D1Database): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-releases-v6:${limit || 'all'}`;

  // Tier 1: in-memory cache (same worker process, ~0ms)
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Tier 2: KV cache (cross-edge, ~30ms) -> Tier 3: D1/Firebase
  const result = await kvCacheThrough(
    cacheKey,
    async () => {
      // Try D1 first if database is provided
      if (db) {
        try {
          // Fetch more than needed to allow for JS sorting by upload date
          const fetchLimit = limit ? limit * 2 : 100;
          const query = `SELECT data FROM releases_v2 WHERE published = 1 OR status = 'live' LIMIT ?`;

          const stmt = db.prepare(query).bind(fetchLimit);
          const { results } = await stmt.all();

          if (results && results.length > 0) {
            let releases = results.map((row) => {
              try {
                const doc = JSON.parse((row as Record<string, unknown>).data as string) as Record<string, unknown>;
                doc.id = doc.id || (row as Record<string, unknown>).id;
                return doc;
              } catch (e: unknown) {
                log.error('[firebase-rest] Failed to parse D1 release row:', e instanceof Error ? e.message : e);
                return null;
              }
            }).filter(Boolean) as Record<string, unknown>[];

            // Sort by upload date (newest first)
            releases.sort((a, b) => {
              const dateA = new Date(a.uploadedAt || a.createdAt || 0).getTime();
              const dateB = new Date(b.uploadedAt || b.createdAt || 0).getTime();
              return dateB - dateA;
            });

            // Apply limit after sorting
            if (limit && releases.length > limit) {
              releases = releases.slice(0, limit);
            }

            log.info(`[firebase-rest] D1: ${releases.length} releases loaded`);
            return releases;
          }
        } catch (e: unknown) {
          log.error('[firebase-rest] D1 releases error, falling back to Firebase:', e);
        }
      }

      // Fallback to Firebase
      // Try 'status' field first
      let releases = await queryCollection('releases', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit,
        cacheKey: `releases-status-live:${limit}`,
        cacheTTL: CACHE_TTL.RELEASES_LIST
      });

      // If no results, try 'published' field
      if (releases.length === 0) {
        releases = await queryCollection('releases', {
          filters: [{ field: 'published', op: 'EQUAL', value: true }],
          limit,
          cacheKey: `releases-published:${limit}`,
          cacheTTL: CACHE_TTL.RELEASES_LIST
        });
      }

      // Sort by upload date (newest first)
      releases.sort((a, b) => {
        const dateA = new Date(a.uploadedAt || a.createdAt || 0).getTime();
        const dateB = new Date(b.uploadedAt || b.createdAt || 0).getTime();
        return dateB - dateA;
      });

      return releases;
    },
    CACHE_CONFIG.RELEASES
  );

  // Backfill in-memory cache — skip empty results to avoid caching failures
  if (result && result.length > 0) {
    setCache(cacheKey, result, CACHE_TTL.RELEASES_LIST);
  }
  return result;
}

// Get DJ mixes with extended cache
// Now supports D1 as primary source with Firebase fallback
// Cache tiers: 1) in-memory (~0ms) -> 2) KV (~30ms) -> 3) D1/Firebase (~300-900ms)
export async function getLiveDJMixes(limit?: number, db?: D1Database): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-dj-mixes-v2:${limit || 'all'}`;

  // Tier 1: in-memory cache (same worker process, ~0ms)
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Tier 2: KV cache (cross-edge, ~30ms) -> Tier 3: D1/Firebase
  const result = await kvCacheThrough(
    cacheKey,
    async () => {
      // Try D1 first if database is provided
      if (db) {
        try {
          const query = limit
            ? `SELECT data FROM dj_mixes WHERE published = 1 ORDER BY upload_date DESC LIMIT ?`
            : `SELECT data FROM dj_mixes WHERE published = 1 ORDER BY upload_date DESC`;

          const stmt = limit ? db.prepare(query).bind(limit) : db.prepare(query);
          const { results } = await stmt.all();

          if (results && results.length > 0) {
            const mixes = results.map((row) => {
              try {
                const doc = JSON.parse((row as Record<string, unknown>).data as string) as Record<string, unknown>;
                doc.id = doc.id || (row as Record<string, unknown>).id;
                return doc;
              } catch (e: unknown) {
                log.error('[firebase-rest] Failed to parse D1 mix row:', e instanceof Error ? e.message : e);
                return null;
              }
            }).filter(Boolean) as Record<string, unknown>[];

            log.info(`[firebase-rest] D1: ${mixes.length} mixes loaded`);
            return mixes;
          }
        } catch (e: unknown) {
          log.error('[firebase-rest] D1 mixes error, falling back to Firebase:', e);
        }
      }

      // Fallback to Firebase
      const mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'published', op: 'EQUAL', value: true }],
        cacheTTL: CACHE_TTL.DJ_MIXES_LIST
      });

      // Sort by uploadedAt descending (newest first) - done client-side to avoid needing composite index
      mixes.sort((a, b) => {
        const dateA = new Date(a.uploadedAt || a.createdAt || 0).getTime();
        const dateB = new Date(b.uploadedAt || b.createdAt || 0).getTime();
        return dateB - dateA;
      });

      // Apply limit after sorting
      return limit ? mixes.slice(0, limit) : mixes;
    },
    CACHE_CONFIG.DJ_MIXES
  );

  // Backfill in-memory cache — skip empty results to avoid caching failures
  if (result && result.length > 0) {
    setCache(cacheKey, result, CACHE_TTL.DJ_MIXES_LIST);
  }
  return result;
}

// Get published merch with D1 support
// Cache tiers: 1) in-memory (~0ms) -> 2) KV (~30ms) -> 3) D1/Firebase (~300-900ms)
export async function getLiveMerch(limit?: number, db?: D1Database, skipCache?: boolean): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-merch-v2:${limit || 'all'}`;

  // Skip cache if requested (for ensuring fresh data)
  if (!skipCache) {
    // Tier 1: in-memory cache (same worker process, ~0ms)
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Tier 2: KV cache (cross-edge, ~30ms) -> Tier 3: D1/Firebase
  const result = await kvCacheThrough(
    cacheKey,
    async () => {
      // Try D1 first if database is provided
      if (db) {
        try {
          const query = limit
            ? `SELECT data FROM merch WHERE published = 1 ORDER BY created_at DESC LIMIT ?`
            : `SELECT data FROM merch WHERE published = 1 ORDER BY created_at DESC`;

          const stmt = limit ? db.prepare(query).bind(limit) : db.prepare(query);
          const { results } = await stmt.all();

          if (results && results.length > 0) {
            const items = results.map((row) => {
              try {
                const doc = JSON.parse((row as Record<string, unknown>).data as string) as Record<string, unknown>;
                doc.id = doc.id || (row as Record<string, unknown>).id;
                return doc;
              } catch (e: unknown) {
                log.error('[firebase-rest] Failed to parse D1 merch row:', e instanceof Error ? e.message : e);
                return null;
              }
            }).filter(Boolean) as Record<string, unknown>[];

            log.info(`[firebase-rest] D1: ${items.length} merch items loaded`);
            return items;
          }
        } catch (e: unknown) {
          log.error('[firebase-rest] D1 merch error, falling back to Firebase:', e);
        }
      }

      // Fallback to Firebase
      let merchData = await queryCollection('merch', {
        cacheKey: 'merch-firebase',
        cacheTTL: CACHE_TTL.MERCH_LIST
      });

      // Filter to only published/active items locally
      merchData = merchData.filter(item => {
        const isPublished = item.published !== false;
        const isActive = !item.status || item.status === 'active';
        return isPublished && isActive;
      });

      return limit ? merchData.slice(0, limit) : merchData;
    },
    CACHE_CONFIG.MERCH
  );

  // Backfill in-memory cache — skip empty results to avoid caching failures
  if (result && result.length > 0) {
    setCache(cacheKey, result, CACHE_TTL.MERCH_LIST);
  }
  return result;
}

// Extract tracks with preview URLs from releases
export function extractTracksFromReleases(releases: Record<string, unknown>[]): Record<string, unknown>[] {
  const tracks: Record<string, unknown>[] = [];

  for (const release of releases) {
    const releaseTracks = release.tracks || [];

    for (let i = 0; i < releaseTracks.length; i++) {
      const track = releaseTracks[i];
      const audioUrl = track.previewUrl || track.mp3Url || track.audioUrl || null;

      if (audioUrl) {
        tracks.push({
          id: `${release.id}-track-${track.trackNumber || i + 1}`,
          releaseId: release.id,
          title: track.trackName || track.title || track.name || `Track ${i + 1}`,
          artist: release.artistName || release.artist || 'Unknown Artist',
          artwork: release.coverArtUrl || release.artworkUrl || '/place-holder.webp',
          previewUrl: audioUrl,
          duration: track.duration || null
        });
      }
    }
  }

  return tracks;
}

// Fisher-Yates shuffle
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
