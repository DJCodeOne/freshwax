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
 * Extract and verify user from request headers
 * Expects Authorization: Bearer <idToken> header
 * @param request - The incoming request
 * @returns Object with userId if verified, error message if not
 */
export async function verifyRequestUser(request: Request): Promise<{ userId: string | null; email?: string; error?: string }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { userId: null, error: 'Missing or invalid Authorization header' };
  }

  const idToken = authHeader.slice(7); // Remove 'Bearer ' prefix

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
