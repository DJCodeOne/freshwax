// src/lib/paypal-auth.ts
// Shared PayPal authentication utilities
// Used by all PayPal API endpoints and paypal-payouts.ts

import { fetchWithTimeout } from './api-utils';

/**
 * Get PayPal API base URL based on mode
 */
export function getPayPalBaseUrl(mode: string): string {
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
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

  const response = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 10000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get PayPal access token: ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}
