// src/lib/kv-cache.ts
// Cloudflare KV caching utility to reduce Firebase reads
// This cache is shared across ALL worker instances globally

import { createLogger } from './api-utils';

const log = createLogger('kv-cache');

interface CacheOptions {
  ttl?: number;  // Time to live in seconds (default: 60)
  prefix?: string;  // Key prefix for namespacing
}

interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

let kvNamespace: KVNamespace | null = null;

/**
 * Initialize KV cache with the binding from Cloudflare environment
 */
export function initKVCache(env: { CACHE?: KVNamespace } | undefined): void {
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
    return null;
  }

  try {
    const fullKey = options.prefix ? `${options.prefix}:${key}` : key;
    const cached = await kvNamespace.get(fullKey, { type: 'json' });

    if (cached) {
      return cached as T;
    }

    return null;
  } catch (error: unknown) {
    log.error('[KVCache] Get error:', error);
    return null;
  }
}

/**
 * Set value in KV cache
 */
export async function kvSet(key: string, value: unknown, options: CacheOptions = {}): Promise<void> {
  if (!kvNamespace) {
    return;
  }

  try {
    const fullKey = options.prefix ? `${options.prefix}:${key}` : key;
    const ttl = options.ttl || 60;
    if (!options.ttl) log.warn('[kv-cache] No TTL provided, using default 60s for key:', key?.substring(0, 30));

    await kvNamespace.put(fullKey, JSON.stringify(value), {
      expirationTtl: ttl
    });
  } catch (error: unknown) {
    log.error('[KVCache] Set error:', error);
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
  } catch (error: unknown) {
    log.error('[KVCache] Delete error:', error);
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
  kvSet(key, freshData, options).catch((e) => log.error('[KVCache] Background set error:', e));

  return freshData;
}

// Pre-defined cache prefixes and TTLs for common use cases
export const CACHE_CONFIG = {
  RELEASES: { prefix: 'releases', ttl: 1800 },       // 30 minutes for releases
  MERCH: { prefix: 'merch', ttl: 300 },              // 5 minutes for merch
  DJ_MIXES: { prefix: 'dj-mixes', ttl: 120 },       // 2 minutes for DJ mixes
} as const;

/** Invalidate all KV-cached release listings */
export async function invalidateReleasesKVCache(): Promise<void> {
  await Promise.allSettled([
    kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES),
    kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES),
  ]);
}

/** Invalidate all KV-cached mix listings (public get-dj-mixes cache) */
export async function invalidateMixesKVCache(): Promise<void> {
  await Promise.allSettled([
    kvDelete('public:50', { prefix: 'mixes' }),
    kvDelete('public:20', { prefix: 'mixes' }),
    kvDelete('public:100', { prefix: 'mixes' }),
  ]);
}
