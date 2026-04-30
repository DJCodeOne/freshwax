// src/lib/firebase/verify.ts
// User token verification: verifyUserToken, verifyRequestUser

import { fetchWithTimeout } from '../api-utils';
import { log, getEnvVar } from './core';

/**
 * Verify a Firebase ID token and return the user ID
 * Uses Firebase Auth REST API to validate the token
 * @param idToken - The Firebase ID token from the client
 * @returns The user ID if valid, null if invalid
 */
export async function verifyUserToken(idToken: string): Promise<string | null> {
  if (!idToken) return null;

  const apiKey = getEnvVar('FIREBASE_API_KEY');
  if (!apiKey) {
    log.error('verifyUserToken: No API key available');
    return null;
  }

  try {
    // Use Firebase Auth REST API to get user data from token
    const response = await fetchWithTimeout(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      },
      15000
    );

    if (!response.ok) {
      log.warn('verifyUserToken: Token verification failed', response.status);
      return null;
    }

    const data = await response.json();
    const user = data.users?.[0];

    if (!user?.localId) {
      log.warn('verifyUserToken: No user found in response');
      return null;
    }

    return user.localId;
  } catch (error: unknown) {
    log.error('verifyUserToken error:', error);
    return null;
  }
}

/**
 * Extract and verify user from request headers.
 * Prefers Authorization: Bearer <idToken> header; falls back to the __session
 * HttpOnly cookie when no header is present. Cookie fallback supports browsers
 * where Firebase Auth client-side persistence (IndexedDB) fails — the user is
 * still authenticated server-side via the cookie set during login. CSRF
 * protection (SameSite=Lax cookie + X-CSRF-Token header) still applies on POST
 * endpoints, so cross-site requests can't exploit this fallback.
 */
export async function verifyRequestUser(request: Request): Promise<{ userId: string | null; email?: string; error?: string }> {
  const authHeader = request.headers.get('Authorization');
  let idToken: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    idToken = authHeader.slice(7);
  } else {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
    if (match) idToken = match[1];
  }

  if (!idToken) {
    return { userId: null, error: 'Missing or invalid Authorization header' };
  }

  // Get full user info including email from token
  const apiKey = getEnvVar('FIREBASE_API_KEY');
  if (!apiKey) {
    return { userId: null, error: 'Server configuration error' };
  }

  try {
    const response = await fetchWithTimeout(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      },
      15000
    );

    if (!response.ok) {
      return { userId: null, error: 'Invalid or expired token' };
    }

    const data = await response.json();
    const user = data.users?.[0];

    if (!user?.localId) {
      return { userId: null, error: 'Invalid or expired token' };
    }

    return { userId: user.localId, email: user.email || undefined };
  } catch (error: unknown) {
    log.error('verifyRequestUser error:', error);
    return { userId: null, error: 'Token verification failed' };
  }
}
