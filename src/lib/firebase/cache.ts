// src/lib/firebase/cache.ts
// Cache management functions

import { log, cache } from './core';

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
