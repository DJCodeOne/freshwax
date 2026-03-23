// src/lib/paypal-auth.ts
// Shared PayPal authentication utilities
// Used by all PayPal API endpoints and paypal-payouts.ts

import { fetchWithTimeout, createLogger } from './api-utils';
import { TIMEOUTS } from './timeouts';

const log = createLogger('paypal-auth');

/**
 * Get PayPal API base URL based on mode
 */
export function getPayPalBaseUrl(mode: string): string {
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * Execute a PayPal API fetch with a single retry on transient failures (503, network errors).
 * Does NOT retry on 4xx client errors.
 */
export async function paypalFetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number = TIMEOUTS.API
): Promise<Response> {
  try {
    const response = await fetchWithTimeout(url, options, timeoutMs);

    // Retry once on 503 Service Unavailable
    if (response.status === 503) {
      log.warn(`PayPal API returned 503, retrying in ${TIMEOUTS.PAYPAL_RETRY}ms...`);
      await new Promise(resolve => setTimeout(resolve, TIMEOUTS.PAYPAL_RETRY));
      return fetchWithTimeout(url, options, timeoutMs);
    }

    return response;
  } catch (error: unknown) {
    // Retry once on network errors (timeout, DNS, connection refused)
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`PayPal API network error: ${message}, retrying in ${TIMEOUTS.PAYPAL_RETRY}ms...`);
    await new Promise(resolve => setTimeout(resolve, TIMEOUTS.PAYPAL_RETRY));
    return fetchWithTimeout(url, options, timeoutMs);
  }
}

/**
 * Get PayPal access token using client credentials
 */
export async function getPayPalAccessToken(
  clientId: string,
  clientSecret: string,
  mode: string
): Promise<string> {
  const baseUrl = getPayPalBaseUrl(mode);
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await paypalFetchWithRetry(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 10000);

  if (!response.ok) {
    const errorText = await response.text();
    log.error(`PayPal token request failed: ${response.status} - ${errorText}`);
    throw new Error('Failed to get PayPal access token');
  }

  const data = await response.json();
  return data.access_token;
}
