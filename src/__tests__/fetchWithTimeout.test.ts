import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the timeouts import used inside api-utils
vi.mock('../lib/timeouts', () => ({
  TIMEOUTS: { API: 10000 },
}));

import { fetchWithTimeout } from '../lib/api-utils';

// =============================================
// fetchWithTimeout
// =============================================
describe('fetchWithTimeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns response on successful fetch', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await fetchWithTimeout('https://example.com/api');
    expect(result).toBe(mockResponse);
  });

  it('passes URL and options to fetch', async () => {
    const mockResponse = new Response('ok');
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const options: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    };

    await fetchWithTimeout('https://example.com/api', options);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('attaches an AbortSignal to the fetch call', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));

    await fetchWithTimeout('https://example.com/api');

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts fetch when timeout expires', async () => {
    // Use a very short real timeout to avoid slow test
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal;
      // Return a promise that rejects when signal aborts
      return new Promise((_resolve, reject) => {
        capturedSignal!.addEventListener('abort', () => {
          reject(capturedSignal!.reason || new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const promise = fetchWithTimeout('https://example.com/slow', {}, 50);

    await expect(promise).rejects.toThrow();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('uses default timeout from TIMEOUTS.API when not specified', async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      receivedSignal = opts.signal as AbortSignal;
      return Promise.resolve(new Response('ok'));
    });

    await fetchWithTimeout('https://example.com/api');

    expect(receivedSignal).toBeDefined();
    // Signal should not be aborted since fetch resolved immediately
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('does not abort before timeout expires', async () => {
    let capturedSignal: AbortSignal | undefined;
    // Resolve instantly — signal should not be aborted
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal;
      return Promise.resolve(new Response('ok'));
    });

    await fetchWithTimeout('https://example.com/api', {}, 5000);

    expect(capturedSignal!.aborted).toBe(false);
  });

  it('clears timeout after successful fetch (no lingering timer)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));

    await fetchWithTimeout('https://example.com/api');

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('clears timeout even when fetch throws', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(
      fetchWithTimeout('https://example.com/api')
    ).rejects.toThrow('Network error');

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('propagates non-timeout fetch errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      fetchWithTimeout('https://example.com/api')
    ).rejects.toThrow('Failed to fetch');
  });

  it('works with empty options object', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));

    const result = await fetchWithTimeout('https://example.com/api', {});
    expect(result).toBeInstanceOf(Response);
  });

  it('overrides caller-provided signal with internal AbortController signal', async () => {
    const callerController = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));

    await fetchWithTimeout('https://example.com/api', {
      signal: callerController.signal,
    });

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].signal).not.toBe(callerController.signal);
  });

  it('creates a new AbortController per call', async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      signals.push(opts.signal as AbortSignal);
      return Promise.resolve(new Response('ok'));
    });

    await fetchWithTimeout('https://example.com/api/1');
    await fetchWithTimeout('https://example.com/api/2');

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
