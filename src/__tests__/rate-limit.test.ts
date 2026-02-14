import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to reset module state between tests since rate-limit uses module-level Maps
// Import fresh for each describe block
let checkRateLimit: typeof import('../lib/rate-limit').checkRateLimit;
let checkBatchLimit: typeof import('../lib/rate-limit').checkBatchLimit;
let getClientId: typeof import('../lib/rate-limit').getClientId;
let rateLimitResponse: typeof import('../lib/rate-limit').rateLimitResponse;
let delay: typeof import('../lib/rate-limit').delay;
let RateLimiters: typeof import('../lib/rate-limit').RateLimiters;
let BatchLimiters: typeof import('../lib/rate-limit').BatchLimiters;
let initRateLimitKV: typeof import('../lib/rate-limit').initRateLimitKV;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../lib/rate-limit');
  checkRateLimit = mod.checkRateLimit;
  checkBatchLimit = mod.checkBatchLimit;
  getClientId = mod.getClientId;
  rateLimitResponse = mod.rateLimitResponse;
  delay = mod.delay;
  RateLimiters = mod.RateLimiters;
  BatchLimiters = mod.BatchLimiters;
  initRateLimitKV = mod.initRateLimitKV;
});

// =============================================
// checkRateLimit
// =============================================
describe('checkRateLimit', () => {
  it('allows the first request', () => {
    const result = checkRateLimit('test-ip', { maxRequests: 5, windowMs: 60000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('decrements remaining count on each request', () => {
    const config = { maxRequests: 3, windowMs: 60000 };

    const r1 = checkRateLimit('counter-test', config);
    expect(r1.remaining).toBe(2);

    const r2 = checkRateLimit('counter-test', config);
    expect(r2.remaining).toBe(1);

    const r3 = checkRateLimit('counter-test', config);
    expect(r3.remaining).toBe(0);
  });

  it('blocks when maxRequests is exceeded', () => {
    const config = { maxRequests: 2, windowMs: 60000 };

    checkRateLimit('block-test', config); // 1
    checkRateLimit('block-test', config); // 2 (hits max)
    const r3 = checkRateLimit('block-test', config); // should be blocked

    expect(r3.allowed).toBe(false);
    expect(r3.retryAfter).toBeDefined();
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it('uses blockDurationMs when provided', () => {
    const config = { maxRequests: 1, windowMs: 60000, blockDurationMs: 300000 };

    checkRateLimit('block-dur-test', config); // 1 (hits max)
    const r2 = checkRateLimit('block-dur-test', config); // blocked

    expect(r2.allowed).toBe(false);
    // retryAfter = ceil(300000 / 1000) = 300
    expect(r2.retryAfter).toBe(300);
  });

  it('defaults blockDurationMs to windowMs', () => {
    const config = { maxRequests: 1, windowMs: 60000 };

    checkRateLimit('default-block', config); // 1 (hits max)
    const r2 = checkRateLimit('default-block', config); // blocked

    expect(r2.allowed).toBe(false);
    expect(r2.retryAfter).toBe(60);
  });

  it('different keys are tracked independently', () => {
    const config = { maxRequests: 1, windowMs: 60000 };

    checkRateLimit('key-a', config);
    const r2 = checkRateLimit('key-a', config);
    expect(r2.allowed).toBe(false);

    // Different key should still be allowed
    const r3 = checkRateLimit('key-b', config);
    expect(r3.allowed).toBe(true);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    const config = { maxRequests: 1, windowMs: 100 }; // 100ms window

    checkRateLimit('expire-test', config); // 1 (at max)

    vi.advanceTimersByTime(150); // past the window

    const r2 = checkRateLimit('expire-test', config);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0); // maxRequests(1) - 1 = 0

    vi.useRealTimers();
  });

  it('continues blocking even after window when blockedUntil is in the future', () => {
    vi.useFakeTimers();
    const config = { maxRequests: 1, windowMs: 100, blockDurationMs: 5000 };

    checkRateLimit('persist-block', config); // 1 at max
    checkRateLimit('persist-block', config); // blocked, blockedUntil = now + 5000

    vi.advanceTimersByTime(200); // past the 100ms window, but within 5000ms block

    const r3 = checkRateLimit('persist-block', config);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfter).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});

// =============================================
// checkBatchLimit
// =============================================
describe('checkBatchLimit', () => {
  it('allows batch within maxItems limit', () => {
    const result = checkBatchLimit('batch-test', 50, { maxItems: 100 });
    expect(result.allowed).toBe(true);
  });

  it('rejects batch exceeding maxItems', () => {
    const result = checkBatchLimit('batch-test', 150, { maxItems: 100 });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('exceeds maximum');
    expect(result.maxAllowed).toBe(100);
  });

  it('allows batch at exactly maxItems', () => {
    const result = checkBatchLimit('exact-test', 100, { maxItems: 100 });
    expect(result.allowed).toBe(true);
  });

  it('tracks hourly totals when maxTotalPerHour is set', () => {
    const config = { maxItems: 100, maxTotalPerHour: 200 };

    const r1 = checkBatchLimit('hourly-test', 100, config);
    expect(r1.allowed).toBe(true);

    const r2 = checkBatchLimit('hourly-test', 100, config);
    expect(r2.allowed).toBe(true);

    // Now at 200 total — next batch should be rejected
    const r3 = checkBatchLimit('hourly-test', 50, config);
    expect(r3.allowed).toBe(false);
    expect(r3.error).toContain('Hourly limit reached');
    expect(r3.maxAllowed).toBe(0);
  });

  it('allows zero remaining when exactly at hourly limit', () => {
    const config = { maxItems: 200, maxTotalPerHour: 200 };

    const r1 = checkBatchLimit('exact-hourly', 200, config);
    expect(r1.allowed).toBe(true);

    const r2 = checkBatchLimit('exact-hourly', 1, config);
    expect(r2.allowed).toBe(false);
    expect(r2.maxAllowed).toBe(0);
  });

  it('resets hourly count after 1 hour', () => {
    vi.useFakeTimers();
    const config = { maxItems: 100, maxTotalPerHour: 100 };

    checkBatchLimit('reset-hourly', 100, config); // Use up the limit

    vi.advanceTimersByTime(61 * 60 * 1000); // 61 minutes

    const r2 = checkBatchLimit('reset-hourly', 50, config);
    expect(r2.allowed).toBe(true);

    vi.useRealTimers();
  });

  it('skips hourly tracking when maxTotalPerHour is not set', () => {
    const config = { maxItems: 500 };

    // Can exceed any hourly total since it's not configured
    for (let i = 0; i < 10; i++) {
      const result = checkBatchLimit('no-hourly', 500, config);
      expect(result.allowed).toBe(true);
    }
  });

  it('different keys tracked independently', () => {
    const config = { maxItems: 100, maxTotalPerHour: 100 };

    checkBatchLimit('batch-a', 100, config); // Exhausts key-a
    const r2 = checkBatchLimit('batch-a', 1, config);
    expect(r2.allowed).toBe(false);

    // Different key is still available
    const r3 = checkBatchLimit('batch-b', 50, config);
    expect(r3.allowed).toBe(true);
  });
});

// =============================================
// getClientId
// =============================================
describe('getClientId', () => {
  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request('https://example.com', {
      headers: new Headers(headers),
    });
  }

  it('uses CF-Connecting-IP when available', () => {
    const req = makeRequest({ 'CF-Connecting-IP': '1.2.3.4' });
    expect(getClientId(req)).toBe('1.2.3.4');
  });

  it('falls back to X-Forwarded-For (first IP)', () => {
    const req = makeRequest({ 'X-Forwarded-For': '10.0.0.1, 10.0.0.2, 10.0.0.3' });
    expect(getClientId(req)).toBe('10.0.0.1');
  });

  it('trims whitespace from X-Forwarded-For', () => {
    const req = makeRequest({ 'X-Forwarded-For': '  10.0.0.1  , 10.0.0.2' });
    expect(getClientId(req)).toBe('10.0.0.1');
  });

  it('falls back to X-Real-IP', () => {
    const req = makeRequest({ 'X-Real-IP': '172.16.0.1' });
    expect(getClientId(req)).toBe('172.16.0.1');
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const req = makeRequest({
      'CF-Connecting-IP': '1.2.3.4',
      'X-Forwarded-For': '10.0.0.1',
    });
    expect(getClientId(req)).toBe('1.2.3.4');
  });

  it('returns anon- prefixed hash when no IP headers present', () => {
    const req = makeRequest({ 'User-Agent': 'TestBot/1.0' });
    const id = getClientId(req);
    expect(id).toMatch(/^anon-/);
  });

  it('produces consistent hash for same headers', () => {
    const req1 = makeRequest({ 'User-Agent': 'TestBot/1.0', Accept: 'text/html' });
    const req2 = makeRequest({ 'User-Agent': 'TestBot/1.0', Accept: 'text/html' });
    expect(getClientId(req1)).toBe(getClientId(req2));
  });

  it('produces different hash for different user agents', () => {
    const req1 = makeRequest({ 'User-Agent': 'Bot A' });
    const req2 = makeRequest({ 'User-Agent': 'Bot B' });
    expect(getClientId(req1)).not.toBe(getClientId(req2));
  });
});

// =============================================
// rateLimitResponse
// =============================================
describe('rateLimitResponse', () => {
  it('returns 429 status', () => {
    const res = rateLimitResponse(60);
    expect(res.status).toBe(429);
  });

  it('includes Retry-After header', () => {
    const res = rateLimitResponse(120);
    expect(res.headers.get('Retry-After')).toBe('120');
  });

  it('includes error message in JSON body', async () => {
    const res = rateLimitResponse(30);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Rate limit exceeded');
    expect(body.retryAfter).toBe(30);
  });

  it('sets Content-Type to application/json', () => {
    const res = rateLimitResponse(10);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});

// =============================================
// delay
// =============================================
describe('delay', () => {
  it('resolves after the specified time', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = delay(1000).then(() => { resolved = true; });

    expect(resolved).toBe(false);
    vi.advanceTimersByTime(999);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await p;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it('resolves immediately for 0ms', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = delay(0).then(() => { resolved = true; });
    vi.advanceTimersByTime(0);
    await p;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });
});

// =============================================
// RateLimiters pre-configured configs
// =============================================
describe('RateLimiters', () => {
  it('standard allows 60 requests per minute', () => {
    expect(RateLimiters.standard.maxRequests).toBe(60);
    expect(RateLimiters.standard.windowMs).toBe(60 * 1000);
  });

  it('auth allows 10 per 15 min with 30 min block', () => {
    expect(RateLimiters.auth.maxRequests).toBe(10);
    expect(RateLimiters.auth.windowMs).toBe(15 * 60 * 1000);
    expect(RateLimiters.auth.blockDurationMs).toBe(30 * 60 * 1000);
  });

  it('strict allows 5 per minute', () => {
    expect(RateLimiters.strict.maxRequests).toBe(5);
    expect(RateLimiters.strict.windowMs).toBe(60 * 1000);
  });

  it('destructive allows 3 per hour with 1 hour block', () => {
    expect(RateLimiters.destructive.maxRequests).toBe(3);
    expect(RateLimiters.destructive.windowMs).toBe(60 * 60 * 1000);
    expect(RateLimiters.destructive.blockDurationMs).toBe(60 * 60 * 1000);
  });
});

// =============================================
// BatchLimiters pre-configured configs
// =============================================
describe('BatchLimiters', () => {
  it('chatCleanup has correct config', () => {
    expect(BatchLimiters.chatCleanup.maxItems).toBe(500);
    expect(BatchLimiters.chatCleanup.maxTotalPerHour).toBe(2000);
  });

  it('bulkDelete has correct config', () => {
    expect(BatchLimiters.bulkDelete.maxItems).toBe(100);
    expect(BatchLimiters.bulkDelete.maxTotalPerHour).toBe(500);
  });

  it('export has maxItems without hourly limit', () => {
    expect(BatchLimiters.export.maxItems).toBe(1000);
    expect(BatchLimiters.export.maxTotalPerHour).toBeUndefined();
  });
});

// =============================================
// initRateLimitKV
// =============================================
describe('initRateLimitKV', () => {
  it('does not throw when called with a valid KV', () => {
    expect(() => initRateLimitKV({ get: vi.fn(), put: vi.fn() })).not.toThrow();
  });

  it('does not throw when called with null/undefined', () => {
    expect(() => initRateLimitKV(null)).not.toThrow();
    expect(() => initRateLimitKV(undefined)).not.toThrow();
  });
});
