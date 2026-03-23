// src/lib/firebase/queries.ts
// Core Firestore query functions: queryCollection, getDocument, getSettings, getDocumentsBatch

import { fetchWithTimeout } from '../api-utils';
import { TIMEOUTS } from '../timeouts';
import {
  log,
  PROJECT_ID,
  FIRESTORE_BASE,
  FIREBASE_API_KEY_FALLBACK,
  CACHE_TTL,
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
      }, TIMEOUTS.API_EXTENDED);

      // Single retry after 500ms delay for transient server errors
      if (!response.ok && response.status >= 500 && response.status < 600) {
        log.warn(`Query ${collection} got ${response.status}, retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.RETRY_DELAY));
        response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: fetchHeaders,
          body: JSON.stringify({ structuredQuery })
        }, TIMEOUTS.API_EXTENDED);
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

      let response = await fetchWithTimeout(url, { headers }, TIMEOUTS.API_EXTENDED);

      // Single retry after 500ms delay for transient server errors
      if (!response.ok && response.status >= 500 && response.status < 600) {
        log.warn(`Get document ${collection}/${docId} got ${response.status}, retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.RETRY_DELAY));
        response = await fetchWithTimeout(url, { headers }, TIMEOUTS.API_EXTENDED);
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
      }, TIMEOUTS.API_EXTENDED);

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
