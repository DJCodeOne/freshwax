// src/lib/firebase/read.ts
// Read operations: queryCollection, getDocument, getSettings, getDocumentsBatch,
// getLiveReleases, getLiveDJMixes, getLiveMerch, extractTracksFromReleases, shuffleArray

import { fetchWithTimeout } from '../api-utils';
import { kvCacheThrough, CACHE_CONFIG } from '../kv-cache';
import {
  log,
  PROJECT_ID,
  FIRESTORE_BASE,
  FIREBASE_API_KEY_FALLBACK,
  CACHE_TTL,
  cache,
  pendingRequests,
  getCached,
  setCache,
  getAuthHeaders,
  getEnvVar,
  parseDocument,
  toFirestoreValue,
  validatePath,
} from './core';
import type { QueryOptions } from './core';

// ==========================================
// CORE QUERY FUNCTIONS
// ==========================================

export async function queryCollection(
  collection: string,
  options: QueryOptions = {},
  throwOnError = false
): Promise<Record<string, unknown>[]> {
  validatePath(collection, 'collection');
  // Generate cache key
  const cacheKey = options.cacheKey || `query:${collection}:${JSON.stringify(options)}`;

  // Check cache first (unless skipped)
  if (!options.skipCache) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Check for pending request (deduplication)
  if (pendingRequests.has(cacheKey)) {
    log.info(`Request DEDUPE: ${cacheKey}`);
    return pendingRequests.get(cacheKey)!;
  }

  // Include API key for authenticated reads
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || import.meta.env.PUBLIC_FIREBASE_API_KEY;
  const url = apiKey
    ? `${FIRESTORE_BASE}:runQuery?key=${apiKey}`
    : `${FIRESTORE_BASE}:runQuery`;

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: collection }],
  };

  // Add filters
  if (options.filters && options.filters.length > 0) {
    if (options.filters.length === 1) {
      const f = options.filters[0];
      structuredQuery.where = {
        fieldFilter: {
          field: { fieldPath: f.field },
          op: f.op,
          value: toFirestoreValue(f.value)
        }
      };
    } else {
      structuredQuery.where = {
        compositeFilter: {
          op: 'AND',
          filters: options.filters.map(f => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op,
              value: toFirestoreValue(f.value)
            }
          }))
        }
      };
    }
  }

  // Add ordering
  if (options.orderBy) {
    structuredQuery.orderBy = [{
      field: { fieldPath: options.orderBy.field },
      direction: options.orderBy.direction || 'DESCENDING'
    }];
  }

  // Add limit
  if (options.limit) {
    structuredQuery.limit = options.limit;
  }

  // Create the fetch promise
  const fetchPromise = (async () => {
    try {
      log.info(`Querying ${collection}...`);

      // Add server auth for all Firestore operations
      const authHeaders = await getAuthHeaders();
      const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders };

      let response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify({ structuredQuery })
      }, 15000);

      // Single retry after 500ms delay for transient server errors
      if (!response.ok && response.status >= 500 && response.status < 600) {
        log.warn(`Query ${collection} got ${response.status}, retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: fetchHeaders,
          body: JSON.stringify({ structuredQuery })
        }, 15000);
      }

      if (!response.ok) {
        const errorText = await response.text();
        log.error('Query failed:', errorText);
        if (throwOnError) throw new Error(`Firebase queryCollection failed: ${response.status}`);
        return [];
      }

      const data = await response.json() as Record<string, unknown>[];

      const results = data
        .filter((item) => (item as Record<string, unknown>).document)
        .map((item) => parseDocument((item as Record<string, unknown>).document as Record<string, unknown>))
        .filter((doc): doc is Record<string, unknown> => doc !== null);

      log.info(`Found ${results.length} documents in ${collection}`);

      // Cache the results
      setCache(cacheKey, results, options.cacheTTL || CACHE_TTL.DEFAULT);

      return results;

    } catch (error: unknown) {
      log.error('Query error:', error);
      if (throwOnError) throw error;
      return [];
    } finally {
      // Remove from pending requests
      pendingRequests.delete(cacheKey);
    }
  })();

  // Store in pending requests for deduplication
  pendingRequests.set(cacheKey, fetchPromise);

  return fetchPromise;
}

export async function getDocument(collection: string, docId: string, ttl?: number, throwOnError = false): Promise<Record<string, unknown> | null> {
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
  const cacheKey = `doc:${collection}:${docId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Check for pending request
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
  }

  // Include API key for authenticated reads
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || import.meta.env.PUBLIC_FIREBASE_API_KEY || FIREBASE_API_KEY_FALLBACK;

  // Use dynamic project ID to match setDocument behavior
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  const url = apiKey
    ? `${baseUrl}/${collection}/${docId}?key=${apiKey}`
    : `${baseUrl}/${collection}/${docId}`;

  const fetchPromise = (async () => {
    try {
      // Add server auth for all Firestore operations
      const headers: Record<string, string> = await getAuthHeaders();

      let response = await fetchWithTimeout(url, { headers }, 15000);

      // Single retry after 500ms delay for transient server errors
      if (!response.ok && response.status >= 500 && response.status < 600) {
        log.warn(`Get document ${collection}/${docId} got ${response.status}, retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        response = await fetchWithTimeout(url, { headers }, 15000);
      }

      if (!response.ok) {
        if (response.status === 404) return null;
        // Treat 403 as "document not found" for collections that may have strict rules
        // This allows the caller to handle it gracefully (e.g., return empty playlist)
        if (response.status === 403) {
          log.warn('Get document 403 (access denied):', collection, docId, '- treating as not found');
          return null;
        }
        log.error('Get document failed:', response.status);
        if (throwOnError) throw new Error(`Firebase getDocument failed: ${response.status}`);
        return null;
      }

      const doc = await response.json();
      const parsed = parseDocument(doc);

      if (parsed) {
        setCache(cacheKey, parsed, ttl || CACHE_TTL.DEFAULT);
      }

      return parsed;

    } catch (error: unknown) {
      log.error(`Get document error (${collection}/${docId}):`, error);
      if (throwOnError) throw error;
      return null;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ==========================================
// CACHED SETTINGS HELPER (30 min cache)
// ==========================================

/**
 * Get admin settings with 30-minute cache
 * Use this instead of getDocument('settings', 'admin') to reduce reads
 */
export async function getSettings(): Promise<Record<string, unknown> | null> {
  return getDocument('settings', 'admin', CACHE_TTL.SETTINGS);
}

// ==========================================
// BATCH OPERATIONS (Reduce reads)
// ==========================================

export async function getDocumentsBatch(
  collection: string,
  docIds: string[],
  ttl?: number
): Promise<Map<string, Record<string, unknown>>> {
  const results = new Map<string, Record<string, unknown>>();
  const uncachedIds: string[] = [];

  // Check cache first
  for (const docId of docIds) {
    const cacheKey = `doc:${collection}:${docId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      results.set(docId, cached);
    } else {
      uncachedIds.push(docId);
    }
  }

  if (uncachedIds.length === 0) {
    log.info(`Batch: All ${docIds.length} documents from cache`);
    return results;
  }

  log.info(`Batch: ${results.size} from cache, ${uncachedIds.length} to fetch`);

  // Fetch uncached documents using batchGet
  // Note: REST API has a limit of 100 documents per batch
  const batches = [];
  for (let i = 0; i < uncachedIds.length; i += 100) {
    batches.push(uncachedIds.slice(i, i + 100));
  }

  for (const batch of batches) {
    try {
      const documents = batch.map(id =>
        `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${id}`
      );

      const batchAuthHeaders = await getAuthHeaders();
      const response = await fetchWithTimeout(`${FIRESTORE_BASE}:batchGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...batchAuthHeaders },
        body: JSON.stringify({ documents })
      }, 15000);

      if (!response.ok) {
        log.error('Batch get failed:', response.status);
        continue;
      }

      const data = await response.json();

      for (const item of data) {
        if (item.found) {
          const parsed = parseDocument(item.found);
          if (parsed) {
            results.set(parsed.id, parsed);
            setCache(`doc:${collection}:${parsed.id}`, parsed, ttl || CACHE_TTL.DEFAULT);
          }
        }
      }
    } catch (error: unknown) {
      log.error('Batch get error:', error);
    }
  }

  return results;
}

// ==========================================
// OPTIMIZED HELPER FUNCTIONS
// ==========================================

// Get releases with extended cache for quota optimization
// Now supports D1 as primary source with Firebase fallback
// Cache tiers: 1) in-memory (~0ms) -> 2) KV (~30ms) -> 3) D1/Firebase (~300-900ms)
export async function getLiveReleases(limit?: number, db?: D1Database): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-releases-v2:${limit || 'all'}`;

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

  // Backfill in-memory cache
  setCache(cacheKey, result, CACHE_TTL.RELEASES_LIST);
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

  // Backfill in-memory cache
  setCache(cacheKey, result, CACHE_TTL.DJ_MIXES_LIST);
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

  // Backfill in-memory cache
  setCache(cacheKey, result, CACHE_TTL.MERCH_LIST);
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
