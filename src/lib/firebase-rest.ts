// src/lib/firebase-rest.ts
// Firebase REST API client - works on Cloudflare Pages (no Admin SDK needed)
// WITH CACHING to reduce quota usage

// Conditional logging - only logs in development
const isDev = import.meta.env?.DEV ?? false;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

const PROJECT_ID = 'freshwax-store';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Simple in-memory cache
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes default (extended for quota optimization)

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expires) {
    log.info(`[firebase-rest] Cache HIT: ${key}`);
    return entry.data;
  }
  if (entry) {
    cache.delete(key);
  }
  return null;
}

function setCache(key: string, data: any, ttl: number = CACHE_TTL): void {
  cache.set(key, { data, expires: Date.now() + ttl });
  log.info(`[firebase-rest] Cache SET: ${key} (TTL: ${ttl / 1000}s)`);
}

type FirestoreOp = 'EQUAL' | 'NOT_EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'ARRAY_CONTAINS';

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
}

// Convert JS values to Firestore REST format
function toFirestoreValue(value: any): any {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) 
      ? { integerValue: String(value) }
      : { doubleValue: value };
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

// Convert Firestore REST format back to JS values
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

// Parse a Firestore document into a plain object
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

// Query a collection with filters
export async function queryCollection(
  collection: string,
  options: QueryOptions = {}
): Promise<any[]> {
  // Check cache first
  const cacheKey = options.cacheKey || `query:${collection}:${JSON.stringify(options)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `${FIRESTORE_BASE}:runQuery`;
  
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
  
  try {
    log.info(`[firebase-rest] Querying ${collection}...`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('[firebase-rest] Query failed:', error);
      return [];
    }
    
    const data = await response.json();
    
    const results = data
      .filter((item: any) => item.document)
      .map((item: any) => parseDocument(item.document));
    
    log.info(`[firebase-rest] Found ${results.length} documents in ${collection}`);
    
    // Cache the results
    setCache(cacheKey, results, options.cacheTTL || CACHE_TTL);
    
    return results;
      
  } catch (error) {
    console.error('[firebase-rest] Query error:', error);
    return [];
  }
}

// Get a single document by ID
export async function getDocument(collection: string, docId: string): Promise<any | null> {
  const cacheKey = `doc:${collection}:${docId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `${FIRESTORE_BASE}/${collection}/${docId}`;
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 404) return null;
      console.error('[firebase-rest] Get document failed:', response.status);
      return null;
    }
    
    const doc = await response.json();
    const parsed = parseDocument(doc);
    
    if (parsed) {
      setCache(cacheKey, parsed);
    }
    
    return parsed;
    
  } catch (error) {
    console.error('[firebase-rest] Get document error:', error);
    return null;
  }
}

// List all documents in a collection (paginated)
export async function listCollection(
  collection: string,
  pageSize: number = 100,
  pageToken?: string
): Promise<{ documents: any[]; nextPageToken?: string }> {
  let url = `${FIRESTORE_BASE}/${collection}?pageSize=${pageSize}`;
  if (pageToken) {
    url += `&pageToken=${pageToken}`;
  }
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error('[firebase-rest] List collection failed:', response.status);
      return { documents: [] };
    }
    
    const data = await response.json();
    
    return {
      documents: (data.documents || []).map(parseDocument).filter(Boolean),
      nextPageToken: data.nextPageToken
    };
    
  } catch (error) {
    console.error('[firebase-rest] List collection error:', error);
    return { documents: [] };
  }
}

// Helper: Get releases with status='live' - WITH 10 MINUTE CACHE
export async function getLiveReleases(limit?: number): Promise<any[]> {
  const cacheKey = `live-releases:${limit || 'all'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Try 'status' field first (your main pattern)
  let releases = await queryCollection('releases', {
    filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
    limit,
    cacheKey: `releases-status-live:${limit}`,
    cacheTTL: 10 * 60 * 1000 // 10 minutes
  });
  
  // If no results, try 'published' field
  if (releases.length === 0) {
    releases = await queryCollection('releases', {
      filters: [{ field: 'published', op: 'EQUAL', value: true }],
      limit,
      cacheKey: `releases-published:${limit}`,
      cacheTTL: 10 * 60 * 1000
    });
  }
  
  // Sort by releaseDate client-side since we can't always use orderBy
  releases.sort((a, b) => {
    const dateA = new Date(a.releaseDate || 0).getTime();
    const dateB = new Date(b.releaseDate || 0).getTime();
    return dateB - dateA;
  });
  
  setCache(cacheKey, releases, 10 * 60 * 1000);
  return releases;
}

// Helper: Extract tracks with preview URLs from releases
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
          artwork: release.coverArtUrl || release.artworkUrl || '/logo.webp',
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

// Clear cache (useful for admin operations)
export function clearCache(): void {
  cache.clear();
  log.info('[firebase-rest] Cache cleared');
}