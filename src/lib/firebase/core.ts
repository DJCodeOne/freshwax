// src/lib/firebase/core.ts
// Core state, constants, helpers, auth, caching, value conversion, types

import { createLogger, fetchWithTimeout } from '../api-utils';
import { FIREBASE_API_KEY } from '../constants';
export const log = createLogger('[firebase-rest]');

export const PROJECT_ID = 'freshwax-store';

// Collections that require authenticated reads (PII protection)
export const PROTECTED_COLLECTIONS = ['users', 'orders', 'djLobbyBypass', 'artists', 'pendingPayPalOrders', 'livestreamSlots'];

// Service account auth token cache (Google OAuth2 access token)
let _serviceAccountToken: string | null = null;
let _serviceAccountExpiry: number = 0;

// Legacy auth token cache (Firebase Auth sign-in fallback)
let _legacyAuthToken: string | null = null;
let _legacyAuthExpiry: number = 0;

// Base64url encode a Uint8Array
export function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Base64url encode a string
export function base64urlEncodeString(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Get a Google OAuth2 access token using service account credentials (RS256 JWT).
 * This token bypasses Firestore security rules, giving admin-level access.
 * Falls back to legacy email/password auth if service account is not configured.
 */
export async function getServiceAccountToken(): Promise<string | null> {
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
export async function getLegacyAuthToken(): Promise<string | null> {
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
export async function getAuthHeaders(): Promise<Record<string, string>> {
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
export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return runtimeEnvCache[name] || (import.meta.env as Record<string, string>)?.[name] || defaultValue;
}
export const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Fallback API key for Cloudflare Workers where import.meta.env may not work at runtime
// This is a client-side Firebase API key - safe to include in code
export const FIREBASE_API_KEY_FALLBACK = FIREBASE_API_KEY;

// ==========================================
// ENHANCED CACHING SYSTEM
// ==========================================

export interface CacheEntry {
  data: unknown;
  expires: number;
  fetchedAt: number;
}

// Multi-tier cache with different TTLs
export const cache = new Map<string, CacheEntry>();

// Cache TTL configuration (in milliseconds)
export const CACHE_TTL = {
  // Static/rarely changing data - 10 minutes
  RELEASES_LIST: 30 * 60 * 1000,
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
export const pendingRequests = new Map<string, Promise<unknown>>();

export function getCached(key: string): unknown | null {
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

export function setCache(key: string, data: unknown, ttl: number = CACHE_TTL.DEFAULT): void {
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

export function pruneCache(): void {
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

export type FirestoreOp = 'EQUAL' | 'NOT_EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'ARRAY_CONTAINS' | 'IN';

export interface QueryFilter {
  field: string;
  op: FirestoreOp;
  value: unknown;
}

export interface QueryOptions {
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

export function toFirestoreValue(value: unknown): Record<string, unknown> {
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

export const MAX_FIRESTORE_DEPTH = 100;

export function fromFirestoreValue(val: unknown, depth: number = 0): unknown {
  if (depth > MAX_FIRESTORE_DEPTH) return null;
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
    return ((av.values || []) as unknown[]).map((item: unknown) => fromFirestoreValue(item, depth + 1));
  }
  if ('mapValue' in v) {
    const mv = v.mapValue as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries((mv.fields || {}) as Record<string, unknown>)) {
      obj[k] = fromFirestoreValue(fv, depth + 1);
    }
    return obj;
  }
  return null;
}

export function parseDocument(doc: Record<string, unknown>): Record<string, unknown> | null {
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

export function validatePath(segment: string, label: string): void {
  if (!segment || typeof segment !== 'string') {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (segment.includes('/') || segment.includes('..') || segment.includes('\0') || segment.includes('\\')) {
    throw new Error(`Invalid ${label}: contains forbidden characters`);
  }
}
