import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api-utils (fetchWithTimeout) and timeouts before importing paypal-auth
vi.mock('../lib/api-utils', () => ({
  fetchWithTimeout: vi.fn(),
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../lib/timeouts', () => ({
  TIMEOUTS: {
    API: 10000,
    PAYPAL_RETRY: 100, // Short retry for tests
  },
}));

import { getPayPalBaseUrl, getPayPalAccessToken, paypalFetchWithRetry } from '../lib/paypal-auth';
import { fetchWithTimeout } from '../lib/api-utils';

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);

// =============================================
// getPayPalBaseUrl
// =============================================
describe('getPayPalBaseUrl', () => {
  it('returns live URL for mode "live"', () => {
    expect(getPayPalBaseUrl('live')).toBe('https://api-m.paypal.com');
  });

  it('returns sandbox URL for mode "sandbox"', () => {
    expect(getPayPalBaseUrl('sandbox')).toBe('https://api-m.sandbox.paypal.com');
  });

  it('returns sandbox URL for any non-live mode', () => {
    expect(getPayPalBaseUrl('test')).toBe('https://api-m.sandbox.paypal.com');
    expect(getPayPalBaseUrl('')).toBe('https://api-m.sandbox.paypal.com');
  });

  it('is case-sensitive — "Live" is not "live"', () => {
    expect(getPayPalBaseUrl('Live')).toBe('https://api-m.sandbox.paypal.com');
  });
});

// =============================================
// paypalFetchWithRetry
// =============================================
describe('paypalFetchWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns response on success (no retry needed)', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetchWithTimeout.mockResolvedValueOnce(okResponse);

    const promise = paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' });
    const result = await promise;

    expect(result).toBe(okResponse);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries once on 503 and returns retry response', async () => {
    const error503 = new Response('Service Unavailable', { status: 503 });
    const okResponse = new Response('ok', { status: 200 });
    mockFetchWithTimeout
      .mockResolvedValueOnce(error503)
      .mockResolvedValueOnce(okResponse);

    const result = await paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' });

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(result).toBe(okResponse);
  });

  it('does not retry on 4xx client errors', async () => {
    const error400 = new Response('Bad Request', { status: 400 });
    mockFetchWithTimeout.mockResolvedValueOnce(error400);

    const result = await paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' });

    expect(result).toBe(error400);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 Unauthorized', async () => {
    const error401 = new Response('Unauthorized', { status: 401 });
    mockFetchWithTimeout.mockResolvedValueOnce(error401);

    const result = await paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' });

    expect(result.status).toBe(401);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries once on network error and returns retry response', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce(okResponse);

    const result = await paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' });

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(result).toBe(okResponse);
  });

  it('throws if retry also fails with network error', async () => {
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('DNS failure'))
      .mockRejectedValueOnce(new Error('DNS failure again'));

    await expect(
      paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' })
    ).rejects.toThrow('DNS failure again');
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('passes custom timeout to fetchWithTimeout', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetchWithTimeout.mockResolvedValueOnce(okResponse);

    await paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'POST' }, 5000);

    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://api-m.paypal.com/v1/test',
      { method: 'POST' },
      5000
    );
  });

  it('handles non-Error thrown values in catch', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetchWithTimeout
      .mockRejectedValueOnce('string error')
      .mockResolvedValueOnce(okResponse);

    const result = await paypalFetchWithRetry('https://api-m.paypal.com/v1/test', { method: 'GET' });

    expect(result).toBe(okResponse);
  });
});

// =============================================
// getPayPalAccessToken
// =============================================
describe('getPayPalAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns access_token on success', async () => {
    const tokenResponse = new Response(
      JSON.stringify({ access_token: 'A21AAHexampleToken123', token_type: 'Bearer', expires_in: 32400 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    mockFetchWithTimeout.mockResolvedValueOnce(tokenResponse);

    const token = await getPayPalAccessToken('client-id', 'client-secret', 'sandbox');
    expect(token).toBe('A21AAHexampleToken123');
  });

  it('calls sandbox URL for sandbox mode', async () => {
    const tokenResponse = new Response(
      JSON.stringify({ access_token: 'tok_sandbox' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    mockFetchWithTimeout.mockResolvedValueOnce(tokenResponse);

    await getPayPalAccessToken('cid', 'cs', 'sandbox');
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
      expect.objectContaining({ method: 'POST' }),
      10000
    );
  });

  it('calls live URL for live mode', async () => {
    const tokenResponse = new Response(
      JSON.stringify({ access_token: 'tok_live' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    mockFetchWithTimeout.mockResolvedValueOnce(tokenResponse);

    await getPayPalAccessToken('cid', 'cs', 'live');
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://api-m.paypal.com/v1/oauth2/token',
      expect.objectContaining({ method: 'POST' }),
      10000
    );
  });

  it('sends Basic auth header with base64-encoded credentials', async () => {
    const tokenResponse = new Response(
      JSON.stringify({ access_token: 'tok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    mockFetchWithTimeout.mockResolvedValueOnce(tokenResponse);

    await getPayPalAccessToken('my-client-id', 'my-secret', 'sandbox');

    const expectedAuth = Buffer.from('my-client-id:my-secret').toString('base64');
    const callArgs = mockFetchWithTimeout.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${expectedAuth}`);
  });

  it('sends correct Content-Type and body', async () => {
    const tokenResponse = new Response(
      JSON.stringify({ access_token: 'tok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    mockFetchWithTimeout.mockResolvedValueOnce(tokenResponse);

    await getPayPalAccessToken('cid', 'cs', 'sandbox');

    const callArgs = mockFetchWithTimeout.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(options.body).toBe('grant_type=client_credentials');
  });

  it('throws when PayPal returns an error response', async () => {
    const errorResponse = new Response(
      JSON.stringify({ error: 'invalid_client', error_description: 'Client Authentication failed' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
    mockFetchWithTimeout.mockResolvedValueOnce(errorResponse);

    await expect(
      getPayPalAccessToken('bad-id', 'bad-secret', 'sandbox')
    ).rejects.toThrow('Failed to get PayPal access token');
  });

  it('throws when PayPal returns 500', async () => {
    const serverError = new Response('Internal Server Error', { status: 500 });
    mockFetchWithTimeout.mockResolvedValueOnce(serverError);

    await expect(
      getPayPalAccessToken('cid', 'cs', 'sandbox')
    ).rejects.toThrow('Failed to get PayPal access token');
  });
});
