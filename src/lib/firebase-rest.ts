// src/lib/firebase-rest-optimized.ts
// Firebase REST API client - OPTIMIZED for 50k read quota
// Features: Extended caching, request deduplication, batch operations, smart invalidation

// Conditional logging - only logs in development
const isDev = import.meta.env?.DEV ?? false;
const log = {
  info: (...args: any[]) => isDev && console.log('[firebase-rest]', ...args),
  warn: (...args: any[]) => isDev && console.warn('[firebase-rest]', ...args),
  error: (...args: any[]) => console.error('[firebase-rest]', ...args),
};

const PROJECT_ID = 'freshwax-store';

// ==========================================
// CLOUDFLARE RUNTIME ENV SUPPORT
// ==========================================
// Cache for runtime env vars (set from request context)
let runtimeEnvCache: Record<string, string> = {};

// Initialize env from Cloudflare runtime (call from API routes/pages)
export function initFirebaseEnv(env: Record<string, string>) {
  if (env.FIREBASE_API_KEY) {
    runtimeEnvCache = env;
    log.info('Firebase env initialized from runtime');
  }
}

// Get env var with fallback chain: runtime cache -> import.meta.env -> default
function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return runtimeEnvCache[name] || (import.meta.env as any)?.[name] || defaultValue;
}
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ==========================================
// ENHANCED CACHING SYSTEM
// ==========================================

interface CacheEntry {
  data: any;
  expires: number;
  fetchedAt: number;
}

// Multi-tier cache with different TTLs
const cache = new Map<string, CacheEntry>();

// Cache TTL configuration (in milliseconds)
const CACHE_TTL = {
  // Static/rarely changing data - 10 minutes
  RELEASES_LIST: 10 * 60 * 1000,
  RELEASE_DETAIL: 3 * 60 * 1000,  // 3 minutes for individual releases (balance freshness vs quota)
  DJ_MIXES_LIST: 2 * 60 * 1000, // 2 minutes (reduced for faster updates)
  MERCH_LIST: 10 * 60 * 1000,

  // Semi-dynamic data - 3 minutes
  USER_PROFILE: 3 * 60 * 1000,
  RATINGS: 30 * 1000,  // 30 seconds for ratings
  COMMENTS: 30 * 1000, // 30 seconds for comments

  // Dynamic data - 1 minute
  ORDERS: 1 * 60 * 1000,
  LIVESTREAM: 1 * 60 * 1000,

  // Admin settings - 30 minutes (rarely changes, saves many reads)
  SETTINGS: 30 * 60 * 1000,

  // Default - 5 minutes
  DEFAULT: 5 * 60 * 1000,
};

// Request deduplication - prevent duplicate in-flight requests
const pendingRequests = new Map<string, Promise<any>>();

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expires) {
    log.info(`Cache HIT: ${key} (age: ${Math.round((Date.now() - entry.fetchedAt) / 1000)}s)`);
    return entry.data;
  }
  if (entry) {
    cache.delete(key);
    log.info(`Cache EXPIRED: ${key}`);
  }
  return null;
}

function setCache(key: string, data: any, ttl: number = CACHE_TTL.DEFAULT): void {
  cache.set(key, { 
    data, 
    expires: Date.now() + ttl,
    fetchedAt: Date.now()
  });
  log.info(`Cache SET: ${key} (TTL: ${ttl / 1000}s, size: ${cache.size})`);
  
  // Cleanup old entries if cache grows too large
  if (cache.size > 200) {
    pruneCache();
  }
}

function pruneCache(): void {
  const now = Date.now();
  let pruned = 0;
  for (const [key, entry] of cache) {
    if (now >= entry.expires) {
      cache.delete(key);
      pruned++;
    }
  }
  log.info(`Cache PRUNED: ${pruned} entries removed, ${cache.size} remaining`);
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type FirestoreOp = 'EQUAL' | 'NOT_EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'ARRAY_CONTAINS' | 'IN';

interface QueryFilter {
  field: string;
  op: FirestoreOp;
  value: any;
}

interface QueryOptions {
  filters?: QueryFilter[];
  orderBy?: { field: string; direction?: 'ASCENDING' | 'DESCENDING' };
  limit?: number;
  cacheKey?: string;
  cacheTTL?: number;
  skipCache?: boolean;
}

// ==========================================
// VALUE CONVERSION
// ==========================================

function toFirestoreValue(value: any): any {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) 
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const fields: any = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(val: any): any {
  if (val === undefined || val === null) return null;
  if ('nullValue' in val) return null;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return new Date(val.timestampValue);
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in val) {
    const obj: any = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      obj[k] = fromFirestoreValue(v);
    }
    return obj;
  }
  return null;
}

function parseDocument(doc: any): any {
  if (!doc || !doc.name) return null;
  
  const id = doc.name.split('/').pop();
  const fields = doc.fields || {};
  
  const parsed: any = { id };
  for (const [key, val] of Object.entries(fields)) {
    parsed[key] = fromFirestoreValue(val);
  }
  return parsed;
}

// ==========================================
// CORE QUERY FUNCTIONS
// ==========================================

export async function queryCollection(
  collection: string,
  options: QueryOptions = {}
): Promise<any[]> {
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

  const structuredQuery: any = {
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
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery })
      });
      
      if (!response.ok) {
        const error = await response.text();
        log.error('Query failed:', error);
        return [];
      }
      
      const data = await response.json();
      
      const results = data
        .filter((item: any) => item.document)
        .map((item: any) => parseDocument(item.document));
      
      log.info(`Found ${results.length} documents in ${collection}`);
      
      // Cache the results
      setCache(cacheKey, results, options.cacheTTL || CACHE_TTL.DEFAULT);
      
      return results;
        
    } catch (error) {
      log.error('Query error:', error);
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

// Fallback API key for Cloudflare Workers where import.meta.env may not work at runtime
// This is a client-side Firebase API key - safe to include in code
const FIREBASE_API_KEY_FALLBACK = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

export async function getDocument(collection: string, docId: string, ttl?: number): Promise<any | null> {
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
      const response = await fetch(url);
      
      if (!response.ok) {
        if (response.status === 404) return null;
        // Treat 403 as "document not found" for collections that may have strict rules
        // This allows the caller to handle it gracefully (e.g., return empty playlist)
        if (response.status === 403) {
          log.warn('Get document 403 (access denied):', collection, docId, '- treating as not found');
          return null;
        }
        log.error('Get document failed:', response.status);
        return null;
      }
      
      const doc = await response.json();
      const parsed = parseDocument(doc);
      
      if (parsed) {
        setCache(cacheKey, parsed, ttl || CACHE_TTL.DEFAULT);
      }
      
      return parsed;
      
    } catch (error) {
      log.error('Get document error:', error);
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
export async function getSettings(): Promise<any | null> {
  return getDocument('settings', 'admin', CACHE_TTL.SETTINGS);
}

/**
 * Invalidate settings cache (call after updating settings)
 */
export function invalidateSettingsCache(): void {
  cache.delete('doc:settings:admin');
  log.info('Settings cache invalidated');
}

// ==========================================
// BATCH OPERATIONS (Reduce reads)
// ==========================================

export async function getDocumentsBatch(
  collection: string, 
  docIds: string[],
  ttl?: number
): Promise<Map<string, any>> {
  const results = new Map<string, any>();
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
      
      const response = await fetch(`${FIRESTORE_BASE}:batchGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents })
      });
      
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
    } catch (error) {
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
export async function getLiveReleases(limit?: number, db?: any): Promise<any[]> {
  const cacheKey = `live-releases:${limit || 'all'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Try D1 first if database is provided
  if (db) {
    try {
      const query = limit
        ? `SELECT data FROM releases_v2 WHERE published = 1 OR status = 'live' ORDER BY release_date DESC LIMIT ?`
        : `SELECT data FROM releases_v2 WHERE published = 1 OR status = 'live' ORDER BY release_date DESC`;

      const stmt = limit ? db.prepare(query).bind(limit) : db.prepare(query);
      const { results } = await stmt.all();

      if (results && results.length > 0) {
        const releases = results.map((row: any) => {
          try {
            const doc = JSON.parse(row.data);
            doc.id = doc.id || row.id;
            return doc;
          } catch (e) {
            return null;
          }
        }).filter(Boolean);

        log.info(`[firebase-rest] D1: ${releases.length} releases loaded`);
        setCache(cacheKey, releases, CACHE_TTL.RELEASES_LIST);
        return releases;
      }
    } catch (e) {
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

  // Sort by catalog/label code
  releases.sort((a, b) => {
    const codeA = a.catalogNumber || a.labelCode || '';
    const codeB = b.catalogNumber || b.labelCode || '';
    return codeA.localeCompare(codeB);
  });

  setCache(cacheKey, releases, CACHE_TTL.RELEASES_LIST);
  return releases;
}

// Get DJ mixes with extended cache
// Now supports D1 as primary source with Firebase fallback
export async function getLiveDJMixes(limit?: number, db?: any): Promise<any[]> {
  const cacheKey = `live-mixes:${limit || 'all'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Try D1 first if database is provided
  if (db) {
    try {
      const query = limit
        ? `SELECT data FROM dj_mixes WHERE published = 1 ORDER BY upload_date DESC LIMIT ?`
        : `SELECT data FROM dj_mixes WHERE published = 1 ORDER BY upload_date DESC`;

      const stmt = limit ? db.prepare(query).bind(limit) : db.prepare(query);
      const { results } = await stmt.all();

      if (results && results.length > 0) {
        const mixes = results.map((row: any) => {
          try {
            const doc = JSON.parse(row.data);
            doc.id = doc.id || row.id;
            return doc;
          } catch (e) {
            return null;
          }
        }).filter(Boolean);

        log.info(`[firebase-rest] D1: ${mixes.length} mixes loaded`);
        setCache(cacheKey, mixes, CACHE_TTL.DJ_MIXES_LIST);
        return mixes;
      }
    } catch (e) {
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
  const result = limit ? mixes.slice(0, limit) : mixes;

  setCache(cacheKey, result, CACHE_TTL.DJ_MIXES_LIST);
  return result;
}

// Get published merch with D1 support
export async function getLiveMerch(limit?: number, db?: any, skipCache?: boolean): Promise<any[]> {
  const cacheKey = `live-merch:${limit || 'all'}`;

  // Skip cache if requested (for ensuring fresh data)
  if (!skipCache) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Try D1 first if database is provided
  if (db) {
    try {
      const query = limit
        ? `SELECT data FROM merch WHERE published = 1 ORDER BY created_at DESC LIMIT ?`
        : `SELECT data FROM merch WHERE published = 1 ORDER BY created_at DESC`;

      const stmt = limit ? db.prepare(query).bind(limit) : db.prepare(query);
      const { results } = await stmt.all();

      if (results && results.length > 0) {
        const items = results.map((row: any) => {
          try {
            const doc = JSON.parse(row.data);
            doc.id = doc.id || row.id;
            return doc;
          } catch (e) {
            return null;
          }
        }).filter(Boolean);

        log.info(`[firebase-rest] D1: ${items.length} merch items loaded`);
        setCache(cacheKey, items, 10 * 60 * 1000);
        return items;
      }
    } catch (e) {
      log.error('[firebase-rest] D1 merch error, falling back to Firebase:', e);
    }
  }

  // Fallback to Firebase
  let merchData = await queryCollection('merch', {
    cacheKey: 'merch-firebase',
    cacheTTL: 10 * 60 * 1000
  });

  // Filter to only published/active items locally
  merchData = merchData.filter(item => {
    const isPublished = item.published !== false;
    const isActive = !item.status || item.status === 'active';
    return isPublished && isActive;
  });

  const result = limit ? merchData.slice(0, limit) : merchData;
  setCache(cacheKey, result, 10 * 60 * 1000);
  return result;
}

// Batch get ratings for multiple releases (reduces reads significantly)
export async function getRatingsBatch(releaseIds: string[]): Promise<Map<string, any>> {
  const results = new Map<string, any>();
  
  // Fetch all releases in batch
  const releases = await getDocumentsBatch('releases', releaseIds, CACHE_TTL.RATINGS);
  
  for (const [id, release] of releases) {
    results.set(id, {
      average: release?.ratings?.average || 0,
      count: release?.ratings?.count || 0,
      fiveStarCount: release?.ratings?.fiveStarCount || 0
    });
  }
  
  return results;
}

// Extract tracks with preview URLs from releases
export function extractTracksFromReleases(releases: any[]): any[] {
  const tracks: any[] = [];
  
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

// ==========================================
// CACHE MANAGEMENT
// ==========================================

export function clearCache(pattern?: string): void {
  if (pattern) {
    let cleared = 0;
    for (const key of cache.keys()) {
      if (key.includes(pattern)) {
        cache.delete(key);
        cleared++;
      }
    }
    log.info(`Cache cleared: ${cleared} entries matching "${pattern}"`);
  } else {
    cache.clear();
    log.info('Cache cleared: all entries');
  }
}

export function invalidateReleasesCache(): void {
  clearCache('releases');
  clearCache('live-releases');
}

export function invalidateMixesCache(): void {
  clearCache('mixes');
  clearCache('dj-mixes');
}

export function clearAllMerchCache(): void {
  clearCache('merch');
  clearCache('live-merch');
  log.info('All merch caches cleared');
}

export function invalidateUsersCache(): void {
  clearCache('users');
  clearCache('users');
  clearCache('artists');
}

export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys())
  };
}

// ==========================================
// WRITE OPERATIONS (with cache invalidation)
// ==========================================

export async function setDocument(
  collection: string,
  docId: string,
  data: Record<string, any>,
  idToken?: string
): Promise<{ success: boolean; id: string }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || FIREBASE_API_KEY_FALLBACK;

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('setDocument error:', response.status, errorText);
    let errorMessage = `Failed to set document: ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorJson.error?.status || errorMessage;
    } catch (e) {
      // Use raw text if not JSON
      if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
    }
    throw new Error(errorMessage);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true, id: docId };
}

// Create document only if it doesn't exist (returns false if already exists)
export async function createDocumentIfNotExists(
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<{ success: boolean; exists: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || FIREBASE_API_KEY_FALLBACK;

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  // Use currentDocument.exists=false to only create if doesn't exist
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?currentDocument.exists=false&key=${apiKey}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Check if it's a "document already exists" error
    if (response.status === 400 && errorText.includes('ALREADY_EXISTS')) {
      return { success: false, exists: true };
    }
    // Also check for precondition failed (409) which Firebase may return
    if (response.status === 409 || errorText.includes('FAILED_PRECONDITION')) {
      return { success: false, exists: true };
    }
    log.error('createDocumentIfNotExists error:', response.status, errorText);
    throw new Error(`Failed to create document: ${response.status}`);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true, exists: false };
}

export async function updateDocument(
  collection: string,
  docId: string,
  data: Record<string, any>,
  idToken?: string
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  // Build updateMask for Firestore REST API
  // Dots indicate nested field paths (e.g., roles.artist) - pass these as-is
  // Backticks are only for field names with special chars like hyphens in a segment
  const updateMask = Object.keys(data).map(key => {
    // Check each segment of the field path
    const segments = key.split('.');
    const quotedSegments = segments.map(segment => {
      // Only quote if segment has special characters (not just alphanumeric/underscore)
      return /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(segment) ? segment : `\`${segment}\``;
    });
    const quotedKey = quotedSegments.join('.');
    return `updateMask.fieldPaths=${encodeURIComponent(quotedKey)}`;
  }).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?${updateMask}&key=${apiKey}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('updateDocument error:', response.status, error);
    console.error('updateDocument collection:', collection, 'docId:', docId);
    console.error('updateDocument had token:', !!idToken);
    throw new Error(`Failed to update document: ${response.status} - ${error}`);
  }

  // Invalidate cache
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true };
}

export async function deleteDocument(
  collection: string,
  docId: string,
  idToken?: string
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const response = await fetch(url, {
    method: 'DELETE',
    headers
  });

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    log.error('deleteDocument error:', error);
    throw new Error(`Failed to delete document: ${response.status}`);
  }

  // Invalidate cache
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true };
}

// Increment a numeric field (read-modify-write)
export async function incrementField(
  collection: string,
  docId: string,
  fieldName: string,
  incrementBy: number = 1
): Promise<{ success: boolean; newValue: number }> {
  const doc = await getDocument(collection, docId);
  if (!doc) {
    throw new Error(`Document ${collection}/${docId} not found`);
  }

  const currentValue = typeof doc[fieldName] === 'number' ? doc[fieldName] : 0;
  const newValue = currentValue + incrementBy;

  await updateDocument(collection, docId, { [fieldName]: newValue });

  return { success: true, newValue };
}

// Append to an array field
export async function arrayUnion(
  collection: string,
  docId: string,
  fieldName: string,
  values: any[]
): Promise<{ success: boolean }> {
  const doc = await getDocument(collection, docId);
  if (!doc) {
    throw new Error(`Document ${collection}/${docId} not found`);
  }

  const currentArray = Array.isArray(doc[fieldName]) ? doc[fieldName] : [];
  const newArray = [...currentArray, ...values];

  await updateDocument(collection, docId, { [fieldName]: newArray });

  return { success: true };
}

// Remove from an array field
export async function arrayRemove(
  collection: string,
  docId: string,
  fieldName: string,
  values: any[]
): Promise<{ success: boolean }> {
  const doc = await getDocument(collection, docId);
  if (!doc) {
    throw new Error(`Document ${collection}/${docId} not found`);
  }

  const currentArray = Array.isArray(doc[fieldName]) ? doc[fieldName] : [];
  const newArray = currentArray.filter((item: any) => !values.includes(item));

  await updateDocument(collection, docId, { [fieldName]: newArray });

  return { success: true };
}

// Add a document with auto-generated ID
// idToken is optional - if provided, request is authenticated
export async function addDocument(
  collection: string,
  data: Record<string, any>,
  idToken?: string
): Promise<{ success: boolean; id: string }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?key=${apiKey}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('addDocument error:', error);
    throw new Error(`Failed to add document: ${response.status}`);
  }

  const result = await response.json();
  // Extract ID from name path like "projects/.../documents/collection/docId"
  const docId = result.name.split('/').pop();

  // Clear collection query cache
  clearCache(`query:${collection}`);

  return { success: true, id: docId };
}

// Export cache TTL config for external use
export { CACHE_TTL };

// ==========================================
// USER TOKEN VERIFICATION
// ==========================================

/**
 * Verify a Firebase ID token and return the user ID
 * Uses Firebase Auth REST API to validate the token
 * @param idToken - The Firebase ID token from the client
 * @returns The user ID if valid, null if invalid
 */
export async function verifyUserToken(idToken: string): Promise<string | null> {
  if (!idToken) return null;

  const apiKey = getEnvVar('FIREBASE_API_KEY');
  if (!apiKey) {
    log.error('verifyUserToken: No API key available');
    return null;
  }

  try {
    // Use Firebase Auth REST API to get user data from token
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );

    if (!response.ok) {
      log.warn('verifyUserToken: Token verification failed', response.status);
      return null;
    }

    const data = await response.json();
    const user = data.users?.[0];

    if (!user?.localId) {
      log.warn('verifyUserToken: No user found in response');
      return null;
    }

    return user.localId;
  } catch (error) {
    log.error('verifyUserToken error:', error);
    return null;
  }
}

/**
 * Extract and verify user from request headers
 * Expects Authorization: Bearer <idToken> header
 * @param request - The incoming request
 * @returns Object with userId if verified, error message if not
 */
export async function verifyRequestUser(request: Request): Promise<{ userId: string | null; error?: string }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { userId: null, error: 'Missing or invalid Authorization header' };
  }

  const idToken = authHeader.slice(7); // Remove 'Bearer ' prefix
  const userId = await verifyUserToken(idToken);

  if (!userId) {
    return { userId: null, error: 'Invalid or expired token' };
  }

  return { userId };
}
