// src/pages/api/admin/debug-update-user.ts
// Debug endpoint to directly update user roles with verbose logging

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, successResponse, jsonResponse } from '../../../lib/api-utils';

export const prerender = false;

// Get service account token
async function getToken(serviceAccountKey: string): Promise<string> {
  const key = JSON.parse(serviceAccountKey);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: key.token_uri,
    iat: now,
    exp: now + 3600
  };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const privateKeyPem = key.private_key;
  const pemContents = privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureData = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, signatureData);
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${headerB64}.${payloadB64}.${signatureB64}`;

  const tokenResponse = await fetchWithTimeout(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  }, 10000);

  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status}`);
  }

  const tokenData = await tokenResponse.json() as Record<string, unknown>;
  return tokenData.access_token as string;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`debug-update-user:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') || 'JueT7q9eKjQk4iFRg2tXa4ZP8642';
  const confirm = url.searchParams.get('confirm');

  const env = locals.runtime.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    const token = await getToken(serviceAccountKey);
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;

    // First, GET the current document
    const getResponse = await fetchWithTimeout(docUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, 10000);
    if (!getResponse.ok) {
      return ApiErrors.serverError(`Failed to fetch user document: ${getResponse.status}`);
    }
    const currentDoc = await getResponse.json() as Record<string, unknown>;

    // Extract current roles
    const currentRoles: Record<string, unknown> = {};
    const rolesField = ((currentDoc.fields as Record<string, unknown>)?.roles as Record<string, unknown>)?.mapValue as Record<string, unknown>;
    const rolesFields = (rolesField?.fields || {}) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(rolesFields)) {
      currentRoles[k] = v.booleanValue;
    }

    if (confirm !== 'yes') {
      return jsonResponse({
        message: 'Current state (add &confirm=yes to update)',
        userId,
        currentRoles,
        willSetArtistTo: false
      });
    }

    // Build new roles with artist=false
    const newRoles = { ...currentRoles, artist: false };

    // Build Firestore value for roles map
    const rolesMapFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(newRoles)) {
      rolesMapFields[k] = { booleanValue: v };
    }

    // PATCH the document
    const patchUrl = `${docUrl}?updateMask.fieldPaths=roles`;
    const patchBody = {
      fields: {
        roles: {
          mapValue: {
            fields: rolesMapFields
          }
        }
      }
    };

    const patchResponse = await fetchWithTimeout(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patchBody)
    }, 10000);

    const patchResult = await patchResponse.json();

    if (!patchResponse.ok) {
      return ApiErrors.serverError('PATCH failed');
    }

    // Verify by fetching again
    const verifyResponse = await fetchWithTimeout(docUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, 10000);
    if (!verifyResponse.ok) {
      return ApiErrors.serverError(`Failed to verify update: ${verifyResponse.status}`);
    }
    const verifyDoc = await verifyResponse.json() as Record<string, unknown>;

    const verifyRoles: Record<string, unknown> = {};
    const verifyRolesMap = ((verifyDoc.fields as Record<string, unknown>)?.roles as Record<string, unknown>)?.mapValue as Record<string, unknown>;
    const verifyRolesField = (verifyRolesMap?.fields || {}) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(verifyRolesField)) {
      verifyRoles[k] = v.booleanValue;
    }

    return successResponse({ message: 'Update complete',
      before: currentRoles,
      requested: newRoles,
      after: verifyRoles,
      artistNowFalse: verifyRoles.artist === false
    });

  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
