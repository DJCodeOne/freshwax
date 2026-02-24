// src/pages/api/admin/fix-track-urls.ts
// Fix mp3Url/wavUrl for tracks in a release

import type { APIRoute } from 'astro';
import { getDocument, invalidateReleasesCache } from '../../../lib/firebase-rest';
import { kvDelete, CACHE_CONFIG } from '../../../lib/kv-cache';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, successResponse } from '../../../lib/api-utils';

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

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`fix-track-urls:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const body = await request.json();
  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const { releaseId, trackFixes } = body;
  // trackFixes: [{ trackIndex: 0, mp3Url: "...", wavUrl: "..." }, ...]

  if (!releaseId || !trackFixes) {
    return ApiErrors.badRequest('Missing releaseId or trackFixes');
  }

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
    // Get current release
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return ApiErrors.notFound('Release not found');
    }

    const tracks = release.tracks || [];

    // Apply fixes
    for (const fix of trackFixes) {
      const { trackIndex, mp3Url, wavUrl, previewUrl } = fix;
      if (trackIndex >= 0 && trackIndex < tracks.length) {
        if (mp3Url !== undefined) tracks[trackIndex].mp3Url = mp3Url;
        if (wavUrl !== undefined) tracks[trackIndex].wavUrl = wavUrl;
        if (previewUrl !== undefined) tracks[trackIndex].previewUrl = previewUrl;
      }
    }

    // Convert tracks array to Firestore format
    const tracksFirestore = tracks.map((track: Record<string, unknown>) => ({
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(track).map(([k, v]) => {
            if (typeof v === 'string') return [k, { stringValue: v }];
            if (typeof v === 'number') return [k, Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }];
            if (typeof v === 'boolean') return [k, { booleanValue: v }];
            if (v === null) return [k, { nullValue: null }];
            if (Array.isArray(v)) return [k, { arrayValue: { values: [] } }]; // simplified
            if (typeof v === 'object') return [k, { mapValue: { fields: {} } }]; // simplified
            return [k, { stringValue: String(v) }];
          })
        )
      }
    }));

    // Update via REST API
    const token = await getToken(serviceAccountKey);
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}?updateMask.fieldPaths=tracks`;

    const patchResponse = await fetchWithTimeout(docUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          tracks: {
            arrayValue: {
              values: tracksFirestore
            }
          }
        }
      })
    }, 10000);

    if (!patchResponse.ok) {
      const errorData = await patchResponse.json();
      return ApiErrors.serverError('Failed to update');
    }

    // Sync updated release to D1 if available
    const db = env?.DB;
    if (db) {
      try {
        const freshRelease = await getDocument('releases', releaseId);
        if (freshRelease) {
          const dataJson = JSON.stringify({ ...freshRelease, id: releaseId });
          const releaseDate = freshRelease.releaseDate || freshRelease.createdAt || new Date().toISOString();
          await db.prepare(
            `UPDATE releases_v2 SET data = ?, release_date = ? WHERE id = ?`
          ).bind(dataJson, releaseDate, releaseId).run();
        }
      } catch (e: unknown) {
        // D1 sync is best-effort, don't fail the request
      }
    }

    // Clear in-memory and KV caches
    invalidateReleasesCache();
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => { /* KV cache invalidation — non-critical */ });
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => { /* KV cache invalidation — non-critical */ });

    return successResponse({ message: 'Track URLs updated and caches cleared',
      releaseId,
      updatedTracks: trackFixes.length });

  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
