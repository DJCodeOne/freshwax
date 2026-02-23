// src/lib/firebase-rest-optimized.ts
// Firebase REST API client - OPTIMIZED for 50k read quota
// Features: Extended caching, request deduplication, batch operations, smart invalidation

import { createLogger, fetchWithTimeout } from './api-utils';
const log = createLogger('[firebase-rest]');

import { kvCacheThrough, CACHE_CONFIG } from './kv-cache';

const PROJECT_ID = 'freshwax-store';

// Collections that require authenticated reads (PII protection)
const PROTECTED_COLLECTIONS = ['users', 'orders', 'djLobbyBypass', 'artists', 'pendingPayPalOrders', 'livestreamSlots'];

// Service account auth token cache (Google OAuth2 access token)
let _serviceAccountToken: string | null = null;
let _serviceAccountExpiry: number = 0;

// Legacy auth token cache (Firebase Auth sign-in fallback)
let _legacyAuthToken: string | null = null;
let _legacyAuthExpiry: number = 0;

// Base64url encode a Uint8Array
function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Base64url encode a string
function base64urlEncodeString(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Get a Google OAuth2 access token using service account credentials (RS256 JWT).
 * This token bypasses Firestore security rules, giving admin-level access.
 * Falls back to legacy email/password auth if service account is not configured.
 */
async function getServiceAccountToken(): Promise<string | null> {
  // Return cached token if still valid
  if (_serviceAccountToken && Date.now() < _serviceAccountExpiry) {
    return _serviceAccountToken;
  }

  const clientEmail = getEnvVar('FIREBASE_CLIENT_EMAIL');
  const privateKeyPem = getEnvVar('FIREBASE_PRIVATE_KEY');

  if (!clientEmail || !privateKeyPem) {
    // Fall back to legacy email/password auth
    return getLegacyAuthToken();
  }

  try {
    const now = Math.floor(Date.now() / 1000);

    // JWT Header
    const header = base64urlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));

    // JWT Payload
    const payload = base64urlEncodeString(JSON.stringify({
      iss: clientEmail,
      sub: clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/datastore',
      iat: now,
      exp: now + 3600,
    }));

    const unsignedToken = `${header}.${payload}`;

    // Parse PEM private key (handle both literal \n and real newlines)
    const pemContents = privateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\\n/g, '')
      .replace(/\s/g, '');

    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    // Import as PKCS8 RSA key for signing
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign the JWT
    const signatureBuffer = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    );

    const signature = base64urlEncode(new Uint8Array(signatureBuffer));
    const jwt = `${unsignedToken}.${signature}`;

    // Exchange JWT for OAuth2 access token
    const tokenResponse = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
    }, 10000);

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      log.error('Service account token exchange failed:', tokenResponse.status, errorText);
      return getLegacyAuthToken();
    }

    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    _serviceAccountToken = tokenData.access_token as string;
    // Refresh 5 minutes before expiry (tokens last 3600s)
    _serviceAccountExpiry = Date.now() + (((tokenData.expires_in as number) || 3600) * 1000) - (5 * 60 * 1000);
    log.info('Service account token acquired');
    return _serviceAccountToken;
  } catch (err: unknown) {
    log.error('Service account auth error:', err);
    return getLegacyAuthToken();
  }
}

/**
 * Legacy email/password auth fallback.
 * Used when FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not configured.
 */
async function getLegacyAuthToken(): Promise<string | null> {
  if (_legacyAuthToken && Date.now() < _legacyAuthExpiry) {
    return _legacyAuthToken;
  }

  const email = getEnvVar('FIREBASE_SERVICE_EMAIL');
  const password = getEnvVar('FIREBASE_SERVICE_PASSWORD');
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!email || !password || !apiKey) return null;

  try {
    const response = await fetchWithTimeout(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      },
      15000
    );

    if (!response.ok) {
      log.error('Legacy auth sign-in failed:', response.status);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    _legacyAuthToken = data.idToken as string;
    // Refresh 5 minutes before expiry (tokens last ~3600s)
    _legacyAuthExpiry = Date.now() + (parseInt((data.expiresIn as string) || '3600') * 1000) - (5 * 60 * 1000);
    log.info('Legacy auth token refreshed');
    return _legacyAuthToken;
  } catch (err: unknown) {
    log.error('Legacy auth error:', err);
    return null;
  }
}

/**
 * Get Authorization headers for server-side Firestore operations.
 * Returns { Authorization: 'Bearer <token>' } when service account is available, or {} otherwise.
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getServiceAccountToken();
  if (token) {
    return { 'Authorization': `Bearer ${token}` };
  }
  return {};
}

// ==========================================
// CLOUDFLARE RUNTIME ENV SUPPORT
// ==========================================
// Cache for runtime env vars (set from request context)
let runtimeEnvCache: Record<string, string> = {};

// Initialize env from Cloudflare runtime (call from API routes/pages)
export function initFirebaseEnv(env: Record<string, string>) {
  if (env.FIREBASE_API_KEY) {
    // Merge into existing cache (don't replace) so middleware's full env isn't wiped
    // by per-endpoint calls that only pass PROJECT_ID + API_KEY
    runtimeEnvCache = { ...runtimeEnvCache, ...env };
    log.info('Firebase env initialized from runtime');
  }
}

// Get env var with fallback chain: runtime cache -> import.meta.env -> default
function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return runtimeEnvCache[name] || (import.meta.env as Record<string, string>)?.[name] || defaultValue;
}
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ==========================================
// ENHANCED CACHING SYSTEM
// ==========================================

interface CacheEntry {
  data: unknown;
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
const pendingRequests = new Map<string, Promise<unknown>>();

function getCached(key: string): unknown | null {
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

function setCache(key: string, data: unknown, ttl: number = CACHE_TTL.DEFAULT): void {
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
  // First pass: remove expired entries
  for (const [key, entry] of cache) {
    if (now >= entry.expires) {
      cache.delete(key);
      pruned++;
    }
  }
  // Second pass: if still over 150, evict oldest by fetchedAt (LRU)
  if (cache.size > 150) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const toRemove = cache.size - 150;
    for (let i = 0; i < toRemove; i++) {
      cache.delete(sorted[i][0]);
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
  value: unknown;
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

function toFirestoreValue(value: unknown): Record<string, unknown> {
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
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(val: unknown): unknown {
  if (val === undefined || val === null) return null;
  const v = val as Record<string, unknown>;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue as string, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue as string);
  if ('arrayValue' in v) {
    const av = v.arrayValue as Record<string, unknown>;
    return ((av.values || []) as unknown[]).map(fromFirestoreValue);
  }
  if ('mapValue' in v) {
    const mv = v.mapValue as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries((mv.fields || {}) as Record<string, unknown>)) {
      obj[k] = fromFirestoreValue(fv);
    }
    return obj;
  }
  return null;
}

function parseDocument(doc: Record<string, unknown>): Record<string, unknown> | null {
  if (!doc || !doc.name) return null;

  const id = (doc.name as string).split('/').pop();
  const fields = (doc.fields || {}) as Record<string, unknown>;

  const parsed: Record<string, unknown> = { id };
  for (const [key, val] of Object.entries(fields)) {
    parsed[key] = fromFirestoreValue(val);
  }
  // Preserve Firestore metadata for optimistic concurrency control
  if (doc.updateTime) parsed._updateTime = doc.updateTime;
  if (doc.createTime) parsed._createTime = doc.createTime;
  return parsed;
}

// ==========================================
// PATH VALIDATION
// ==========================================

function validatePath(segment: string, label: string): void {
  if (!segment || typeof segment !== 'string') {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (segment.includes('/') || segment.includes('..') || segment.includes('\0') || segment.includes('\\')) {
    throw new Error(`Invalid ${label}: contains forbidden characters`);
  }
}

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

      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify({ structuredQuery })
      }, 15000);
      
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

// Fallback API key for Cloudflare Workers where import.meta.env may not work at runtime
// This is a client-side Firebase API key - safe to include in code
const FIREBASE_API_KEY_FALLBACK = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

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

      const response = await fetchWithTimeout(url, { headers }, 15000);

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
// Cache tiers: 1) in-memory (~0ms) → 2) KV (~30ms) → 3) D1/Firebase (~300-900ms)
export async function getLiveReleases(limit?: number, db?: D1Database): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-releases-v2:${limit || 'all'}`;

  // Tier 1: in-memory cache (same worker process, ~0ms)
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Tier 2: KV cache (cross-edge, ~30ms) → Tier 3: D1/Firebase
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
// Cache tiers: 1) in-memory (~0ms) → 2) KV (~30ms) → 3) D1/Firebase (~300-900ms)
export async function getLiveDJMixes(limit?: number, db?: D1Database): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-dj-mixes-v2:${limit || 'all'}`;

  // Tier 1: in-memory cache (same worker process, ~0ms)
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Tier 2: KV cache (cross-edge, ~30ms) → Tier 3: D1/Firebase
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
// Cache tiers: 1) in-memory (~0ms) → 2) KV (~30ms) → 3) D1/Firebase (~300-900ms)
export async function getLiveMerch(limit?: number, db?: D1Database, skipCache?: boolean): Promise<Record<string, unknown>[]> {
  const cacheKey = `live-merch-v2:${limit || 'all'}`;

  // Skip cache if requested (for ensuring fresh data)
  if (!skipCache) {
    // Tier 1: in-memory cache (same worker process, ~0ms)
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Tier 2: KV cache (cross-edge, ~30ms) → Tier 3: D1/Firebase
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
  data: Record<string, unknown>,
  idToken?: string
): Promise<{ success: boolean; id: string }> {
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || FIREBASE_API_KEY_FALLBACK;

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const errorText = await response.text();
    log.error('setDocument error:', response.status, errorText);
    let errorMessage = `Failed to set document: ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorJson.error?.status || errorMessage;
    } catch (e: unknown) {
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
  data: Record<string, unknown>
): Promise<{ success: boolean; exists: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || FIREBASE_API_KEY_FALLBACK;

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  // Use currentDocument.exists=false to only create if doesn't exist
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?currentDocument.exists=false&key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const cdinHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: cdinHeaders,
    body: JSON.stringify({ fields })
  }, 15000);

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
  data: Record<string, unknown>,
  idToken?: string
): Promise<{ success: boolean }> {
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
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

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('updateDocument error:', response.status, error);
    log.error('updateDocument collection:', collection, 'docId:', docId);
    log.error('updateDocument had token:', !!idToken);
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
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers
  }, 15000);

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

/**
 * Atomically increment numeric fields using Firestore's commit API with fieldTransforms.
 * Unlike incrementField, this does NOT do read-modify-write and is safe against race conditions.
 * @param collection - Firestore collection
 * @param docId - Document ID
 * @param increments - Map of field paths to increment values (negative for decrement)
 */
export async function atomicIncrement(
  collection: string,
  docId: string,
  increments: Record<string, number>
): Promise<{ success: boolean; newValues: Record<string, number> }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const fields = Object.keys(increments);
  const fieldTransforms = Object.entries(increments).map(([field, value]) => ({
    fieldPath: field,
    increment: Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value }
  }));

  const atomicHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: atomicHeaders,
    body: JSON.stringify({
      writes: [{
        transform: {
          document: documentPath,
          fieldTransforms
        }
      }]
    })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('atomicIncrement error:', error);
    throw new Error(`Atomic increment failed: ${response.status}`);
  }

  // Parse transform results to get new values
  const newValues: Record<string, number> = {};
  try {
    const result = await response.json();
    const transformResults = result?.writeResults?.[0]?.transformResults || [];
    for (let i = 0; i < fields.length && i < transformResults.length; i++) {
      const tr = transformResults[i];
      newValues[fields[i]] = Number(tr.integerValue ?? tr.doubleValue ?? 0);
    }
  } catch {
    // If parsing fails, return empty newValues - callers should handle gracefully
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true, newValues };
}

/**
 * Update a document only if it hasn't been modified since expectedUpdateTime.
 * Uses Firestore's commit API with currentDocument precondition for optimistic concurrency.
 * Throws an error containing 'CONFLICT' if the document was modified by another request.
 */
export async function updateDocumentConditional(
  collection: string,
  docId: string,
  data: Record<string, unknown>,
  expectedUpdateTime: string
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const conditionalHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: conditionalHeaders,
    body: JSON.stringify({
      writes: [{
        update: {
          name: documentPath,
          fields
        },
        updateMask: {
          fieldPaths: Object.keys(data)
        },
        currentDocument: {
          updateTime: expectedUpdateTime
        }
      }]
    })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 409 || error.includes('FAILED_PRECONDITION')) {
      throw new Error('CONFLICT: Document was modified by another request');
    }
    log.error('updateDocumentConditional error:', error);
    throw new Error(`Conditional update failed: ${response.status}`);
  }

  // Invalidate cache
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true };
}

/**
 * Atomically append elements to an array field using Firestore's commit API with fieldTransforms.
 * Uses appendMissingElements (Firestore's arrayUnion) so concurrent appends never lose data.
 * Unlike the old read-modify-write approach, this is safe against race conditions.
 *
 * Note: appendMissingElements deduplicates by value. Since each element includes a unique `id`
 * and `createdAt`/`timestamp`, duplicates are effectively impossible for comments/transactions.
 *
 * @param collection - Firestore collection
 * @param docId - Document ID
 * @param fieldName - The array field to append to
 * @param values - Array of values to append
 * @param additionalFields - Optional additional fields to update on the same document (e.g. commentCount, lastUpdated)
 */
export async function arrayUnion(
  collection: string,
  docId: string,
  fieldName: string,
  values: unknown[],
  additionalFields?: Record<string, unknown>
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const writes: Record<string, unknown>[] = [];

  // Write 1: Field transform to atomically append to the array
  writes.push({
    transform: {
      document: documentPath,
      fieldTransforms: [{
        fieldPath: fieldName,
        appendMissingElements: {
          values: values.map(v => toFirestoreValue(v))
        }
      }]
    }
  });

  // Write 2: If there are additional fields to update (e.g. updatedAt, commentCount), add a separate update write
  if (additionalFields && Object.keys(additionalFields).length > 0) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(additionalFields)) {
      fields[key] = toFirestoreValue(value);
    }
    writes.push({
      update: {
        name: documentPath,
        fields
      },
      updateMask: {
        fieldPaths: Object.keys(additionalFields)
      }
    });
  }

  const arrayUnionHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: arrayUnionHeaders,
    body: JSON.stringify({ writes })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('arrayUnion error:', error);
    throw new Error(`Atomic arrayUnion failed: ${response.status}`);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true };
}

/**
 * Atomically removes values from an array field in a Firestore document.
 * Uses Firestore's removeAllFromArray transform to avoid race conditions.
 * @param collection - The Firestore collection
 * @param docId - The document ID
 * @param fieldName - The array field to remove from
 * @param values - Array of values to remove
 * @param additionalFields - Optional additional fields to update on the same document (e.g. updatedAt)
 */
export async function arrayRemove(
  collection: string,
  docId: string,
  fieldName: string,
  values: unknown[],
  additionalFields?: Record<string, unknown>
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const writes: Record<string, unknown>[] = [];

  // Write 1: Field transform to atomically remove from the array
  writes.push({
    transform: {
      document: documentPath,
      fieldTransforms: [{
        fieldPath: fieldName,
        removeAllFromArray: {
          values: values.map(v => toFirestoreValue(v))
        }
      }]
    }
  });

  // Write 2: If there are additional fields to update (e.g. updatedAt), add a separate update write
  if (additionalFields && Object.keys(additionalFields).length > 0) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(additionalFields)) {
      fields[key] = toFirestoreValue(value);
    }
    writes.push({
      update: {
        name: documentPath,
        fields
      },
      updateMask: {
        fieldPaths: Object.keys(additionalFields)
      }
    });
  }

  const arrayRemoveHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: arrayRemoveHeaders,
    body: JSON.stringify({ writes })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('arrayRemove error:', error);
    throw new Error(`Atomic arrayRemove failed: ${response.status}`);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true };
}

// Add a document with auto-generated ID
// idToken is optional - if provided, request is authenticated
export async function addDocument(
  collection: string,
  data: Record<string, unknown>,
  idToken?: string
): Promise<{ success: boolean; id: string }> {
  validatePath(collection, 'collection');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields })
  }, 15000);

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
    const response = await fetchWithTimeout(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      },
      15000
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
  } catch (error: unknown) {
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
export async function verifyRequestUser(request: Request): Promise<{ userId: string | null; email?: string; error?: string }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { userId: null, error: 'Missing or invalid Authorization header' };
  }

  const idToken = authHeader.slice(7); // Remove 'Bearer ' prefix

  // Get full user info including email from token
  const apiKey = getEnvVar('FIREBASE_API_KEY');
  if (!apiKey) {
    return { userId: null, error: 'Server configuration error' };
  }

  try {
    const response = await fetchWithTimeout(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      },
      15000
    );

    if (!response.ok) {
      return { userId: null, error: 'Invalid or expired token' };
    }

    const data = await response.json();
    const user = data.users?.[0];

    if (!user?.localId) {
      return { userId: null, error: 'Invalid or expired token' };
    }

    return { userId: user.localId, email: user.email || undefined };
  } catch (error: unknown) {
    log.error('verifyRequestUser error:', error);
    return { userId: null, error: 'Token verification failed' };
  }
}
