// src/lib/kv-cache.ts
// Cloudflare KV caching utility to reduce Firebase reads
// This cache is shared across ALL worker instances globally

interface CacheOptions {
  ttl?: number;  // Time to live in seconds (default: 60)
  prefix?: string;  // Key prefix for namespacing
}

interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<any>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

let kvNamespace: KVNamespace | null = null;

/**
 * Initialize KV cache with the binding from Cloudflare environment
 */
export function initKVCache(env: any): void {
  if (env?.CACHE) {
    kvNamespace = env.CACHE;
  }
}

/**
 * Get cached value from KV
 * Returns null if not found or expired
 */
export async function kvGet<T>(key: string, options: CacheOptions = {}): Promise<T | null> {
  if (!kvNamespace) {
    console.log('[KVCache] KV not initialized, skipping cache');
    return null;
  }

  try {
    const fullKey = options.prefix ? `${options.prefix}:${key}` : key;
    const cached = await kvNamespace.get(fullKey, { type: 'json' });

    if (cached) {
      console.log('[KVCache] HIT:', fullKey);
      return cached as T;
    }

    console.log('[KVCache] MISS:', fullKey);
    return null;
  } catch (error) {
    console.error('[KVCache] Get error:', error);
    return null;
  }
}

/**
 * Set value in KV cache
 */
export async function kvSet(key: string, value: any, options: CacheOptions = {}): Promise<void> {
  if (!kvNamespace) {
    return;
  }

  try {
    const fullKey = options.prefix ? `${options.prefix}:${key}` : key;
    const ttl = options.ttl || 60; // Default 60 seconds

    await kvNamespace.put(fullKey, JSON.stringify(value), {
      expirationTtl: ttl
    });

    console.log('[KVCache] SET:', fullKey, 'TTL:', ttl);
  } catch (error) {
    console.error('[KVCache] Set error:', error);
  }
}

/**
 * Delete value from KV cache
 */
export async function kvDelete(key: string, options: CacheOptions = {}): Promise<void> {
  if (!kvNamespace) {
    return;
  }

  try {
    const fullKey = options.prefix ? `${options.prefix}:${key}` : key;
    await kvNamespace.delete(fullKey);
    console.log('[KVCache] DELETE:', fullKey);
  } catch (error) {
    console.error('[KVCache] Delete error:', error);
  }
}

/**
 * Cache-through helper: Get from cache or fetch and cache
 * This is the main function to use for reducing Firebase reads
 */
export async function kvCacheThrough<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {}
): Promise<T> {
  // Try cache first
  const cached = await kvGet<T>(key, options);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - fetch fresh data
  const freshData = await fetcher();

  // Cache the result (don't await to avoid blocking)
  kvSet(key, freshData, options).catch(() => {});

  return freshData;
}

// Pre-defined cache prefixes and TTLs for common use cases
export const CACHE_CONFIG = {
  LIVE_STATUS: { prefix: 'status', ttl: 60 },        // 1 minute
  LIVE_STATUS_OFFLINE: { prefix: 'status', ttl: 120 }, // 2 minutes when offline
  PLAYLIST: { prefix: 'playlist', ttl: 30 },         // 30 seconds for playlist
  USER_DATA: { prefix: 'user', ttl: 300 },           // 5 minutes for user data
  RELEASES: { prefix: 'releases', ttl: 600 },        // 10 minutes for releases
  ARTISTS: { prefix: 'artists', ttl: 600 },          // 10 minutes for artists
  MERCH: { prefix: 'merch', ttl: 300 },              // 5 minutes for merch
} as const;
