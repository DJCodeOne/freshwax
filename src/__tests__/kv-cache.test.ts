import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api-utils module before importing kv-cache
vi.mock('../lib/api-utils', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================
// KV namespace mock
// =============================================
function createMockKV(overrides: {
  getResult?: unknown;
  getError?: Error;
  putError?: Error;
  deleteError?: Error;
} = {}) {
  const getFn = overrides.getError
    ? vi.fn().mockRejectedValue(overrides.getError)
    : vi.fn().mockResolvedValue(overrides.getResult ?? null);
  const putFn = overrides.putError
    ? vi.fn().mockRejectedValue(overrides.putError)
    : vi.fn().mockResolvedValue(undefined);
  const deleteFn = overrides.deleteError
    ? vi.fn().mockRejectedValue(overrides.deleteError)
    : vi.fn().mockResolvedValue(undefined);

  return { get: getFn, put: putFn, delete: deleteFn };
}

// Helper: get a fresh module instance with reset internal state
async function freshModule() {
  vi.resetModules();
  const mod = await import('../lib/kv-cache');
  return mod;
}

// =============================================
// Tests that require uninitialized (null) KV state
// =============================================
describe('kv-cache (uninitialized)', () => {
  it('kvGet returns null when KV is not initialized', async () => {
    const { kvGet } = await freshModule();
    const result = await kvGet('some-key');
    expect(result).toBeNull();
  });

  it('kvSet does nothing when KV is not initialized', async () => {
    const { kvSet } = await freshModule();
    await expect(kvSet('key', 'value')).resolves.toBeUndefined();
  });

  it('kvDelete does nothing when KV is not initialized', async () => {
    const { kvDelete } = await freshModule();
    await expect(kvDelete('key')).resolves.toBeUndefined();
  });

  it('kvCacheThrough calls fetcher when KV is not initialized', async () => {
    const { kvCacheThrough } = await freshModule();
    const fetcher = vi.fn().mockResolvedValue({ data: 'fresh' });
    const result = await kvCacheThrough('key', fetcher);

    expect(fetcher).toHaveBeenCalled();
    expect(result).toEqual({ data: 'fresh' });
  });

  it('invalidateReleasesKVCache does not throw when KV is not initialized', async () => {
    const { invalidateReleasesKVCache } = await freshModule();
    await expect(invalidateReleasesKVCache()).resolves.toBeUndefined();
  });

  it('initKVCache handles undefined env gracefully', async () => {
    const { initKVCache } = await freshModule();
    initKVCache(undefined);
    // Should not throw
  });

  it('initKVCache handles env without CACHE binding', async () => {
    const { initKVCache, kvGet } = await freshModule();
    initKVCache({} as never);
    // CACHE was not present, so kvNamespace remains null
    const result = await kvGet('test-key');
    expect(result).toBeNull();
  });
});

// =============================================
// Tests with initialized KV
// =============================================
describe('initKVCache', () => {
  it('initializes when CACHE binding is present', async () => {
    const { initKVCache, kvGet } = await freshModule();
    const mockKV = createMockKV({ getResult: { data: 'cached' } });
    initKVCache({ CACHE: mockKV as never });
    const result = await kvGet('test-key');
    expect(result).toEqual({ data: 'cached' });
  });
});

// =============================================
// kvGet (with KV initialized)
// =============================================
describe('kvGet', () => {
  it('returns cached value when found', async () => {
    const { initKVCache, kvGet } = await freshModule();
    const mockKV = createMockKV({ getResult: { name: 'test-release' } });
    initKVCache({ CACHE: mockKV as never });

    const result = await kvGet('release-1');
    expect(result).toEqual({ name: 'test-release' });
    expect(mockKV.get).toHaveBeenCalledWith('release-1', { type: 'json' });
  });

  it('returns null when cache miss', async () => {
    const { initKVCache, kvGet } = await freshModule();
    const mockKV = createMockKV({ getResult: null });
    initKVCache({ CACHE: mockKV as never });

    const result = await kvGet('missing-key');
    expect(result).toBeNull();
  });

  it('applies prefix to cache key', async () => {
    const { initKVCache, kvGet } = await freshModule();
    const mockKV = createMockKV({ getResult: 'data' });
    initKVCache({ CACHE: mockKV as never });

    await kvGet('item-1', { prefix: 'releases' });
    expect(mockKV.get).toHaveBeenCalledWith('releases:item-1', { type: 'json' });
  });

  it('uses raw key when no prefix provided', async () => {
    const { initKVCache, kvGet } = await freshModule();
    const mockKV = createMockKV({ getResult: 'data' });
    initKVCache({ CACHE: mockKV as never });

    await kvGet('raw-key');
    expect(mockKV.get).toHaveBeenCalledWith('raw-key', { type: 'json' });
  });

  it('returns null on KV error (does not throw)', async () => {
    const { initKVCache, kvGet } = await freshModule();
    const mockKV = createMockKV({ getError: new Error('KV read failed') });
    initKVCache({ CACHE: mockKV as never });

    const result = await kvGet('error-key');
    expect(result).toBeNull();
  });
});

// =============================================
// kvSet
// =============================================
describe('kvSet', () => {
  it('stores JSON-stringified value with TTL', async () => {
    const { initKVCache, kvSet } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await kvSet('item-1', { name: 'test' }, { ttl: 300 });
    expect(mockKV.put).toHaveBeenCalledWith(
      'item-1',
      JSON.stringify({ name: 'test' }),
      { expirationTtl: 300 }
    );
  });

  it('uses default 60s TTL when none provided', async () => {
    const { initKVCache, kvSet } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await kvSet('item-1', 'data');
    expect(mockKV.put).toHaveBeenCalledWith(
      'item-1',
      JSON.stringify('data'),
      { expirationTtl: 60 }
    );
  });

  it('applies prefix to cache key', async () => {
    const { initKVCache, kvSet } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await kvSet('item-1', 'data', { prefix: 'merch', ttl: 120 });
    expect(mockKV.put).toHaveBeenCalledWith(
      'merch:item-1',
      JSON.stringify('data'),
      { expirationTtl: 120 }
    );
  });

  it('does not throw on KV write error', async () => {
    const { initKVCache, kvSet } = await freshModule();
    const mockKV = createMockKV({ putError: new Error('KV write failed') });
    initKVCache({ CACHE: mockKV as never });

    await expect(kvSet('key', 'val')).resolves.toBeUndefined();
  });
});

// =============================================
// kvDelete
// =============================================
describe('kvDelete', () => {
  it('deletes the key from KV', async () => {
    const { initKVCache, kvDelete } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await kvDelete('old-key');
    expect(mockKV.delete).toHaveBeenCalledWith('old-key');
  });

  it('applies prefix to cache key', async () => {
    const { initKVCache, kvDelete } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await kvDelete('old-key', { prefix: 'releases' });
    expect(mockKV.delete).toHaveBeenCalledWith('releases:old-key');
  });

  it('does not throw on KV delete error', async () => {
    const { initKVCache, kvDelete } = await freshModule();
    const mockKV = createMockKV({ deleteError: new Error('KV delete failed') });
    initKVCache({ CACHE: mockKV as never });

    await expect(kvDelete('key')).resolves.toBeUndefined();
  });
});

// =============================================
// kvCacheThrough
// =============================================
describe('kvCacheThrough', () => {
  it('returns cached value on cache hit (skips fetcher)', async () => {
    const { initKVCache, kvCacheThrough } = await freshModule();
    const mockKV = createMockKV({ getResult: { data: 'cached' } });
    initKVCache({ CACHE: mockKV as never });

    const fetcher = vi.fn().mockResolvedValue({ data: 'fresh' });
    const result = await kvCacheThrough('key', fetcher, { prefix: 'test' });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ data: 'cached' });
  });

  it('calls fetcher and caches result on cache miss', async () => {
    const { initKVCache, kvCacheThrough } = await freshModule();
    const mockKV = createMockKV({ getResult: null });
    initKVCache({ CACHE: mockKV as never });

    const fetcher = vi.fn().mockResolvedValue({ data: 'fresh' });
    const result = await kvCacheThrough('key', fetcher, { ttl: 120 });

    expect(fetcher).toHaveBeenCalled();
    expect(result).toEqual({ data: 'fresh' });
    // kvSet fires in the background — wait a tick for the put call
    await vi.waitFor(() => {
      expect(mockKV.put).toHaveBeenCalled();
    });
  });

  it('returns fresh data even if background cache write fails', async () => {
    const { initKVCache, kvCacheThrough } = await freshModule();
    const mockKV = createMockKV({ getResult: null, putError: new Error('write fail') });
    initKVCache({ CACHE: mockKV as never });

    const fetcher = vi.fn().mockResolvedValue('fresh-data');
    const result = await kvCacheThrough('key', fetcher);

    expect(result).toBe('fresh-data');
  });
});

// =============================================
// CACHE_CONFIG
// =============================================
describe('CACHE_CONFIG', () => {
  it('has RELEASES config with 30-minute TTL', async () => {
    const { CACHE_CONFIG } = await freshModule();
    expect(CACHE_CONFIG.RELEASES).toEqual({ prefix: 'releases', ttl: 1800 });
  });

  it('has MERCH config with 5-minute TTL', async () => {
    const { CACHE_CONFIG } = await freshModule();
    expect(CACHE_CONFIG.MERCH).toEqual({ prefix: 'merch', ttl: 300 });
  });

  it('has DJ_MIXES config with 2-minute TTL', async () => {
    const { CACHE_CONFIG } = await freshModule();
    expect(CACHE_CONFIG.DJ_MIXES).toEqual({ prefix: 'dj-mixes', ttl: 120 });
  });
});

// =============================================
// invalidateReleasesKVCache / invalidateMixesKVCache
// =============================================
describe('invalidateReleasesKVCache', () => {
  it('deletes both release cache keys', async () => {
    const { initKVCache, invalidateReleasesKVCache } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await invalidateReleasesKVCache();
    expect(mockKV.delete).toHaveBeenCalledTimes(2);
    expect(mockKV.delete).toHaveBeenCalledWith('releases:live-releases-v6:20');
    expect(mockKV.delete).toHaveBeenCalledWith('releases:live-releases-v6:all');
  });
});

describe('invalidateMixesKVCache', () => {
  it('deletes all three mix cache keys', async () => {
    const { initKVCache, invalidateMixesKVCache } = await freshModule();
    const mockKV = createMockKV();
    initKVCache({ CACHE: mockKV as never });

    await invalidateMixesKVCache();
    expect(mockKV.delete).toHaveBeenCalledTimes(3);
    expect(mockKV.delete).toHaveBeenCalledWith('mixes:public:50');
    expect(mockKV.delete).toHaveBeenCalledWith('mixes:public:20');
    expect(mockKV.delete).toHaveBeenCalledWith('mixes:public:100');
  });
});
