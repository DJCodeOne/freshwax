// src/pages/api/admin/fix-track-urls.ts
// Fix mp3Url/wavUrl for tracks in a release

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';

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

  const tokenResponse = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenResponse.json() as any;
  return tokenData.access_token;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json();
  const { releaseId, trackFixes } = body;
  // trackFixes: [{ trackIndex: 0, mp3Url: "...", wavUrl: "..." }, ...]

  if (!releaseId || !trackFixes) {
    return new Response(JSON.stringify({
      error: 'Missing releaseId or trackFixes',
      usage: 'POST { releaseId: "xxx", trackFixes: [{ trackIndex: 0, mp3Url: "...", wavUrl: "..." }] }'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const env = (locals as any)?.runtime?.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return new Response(JSON.stringify({ error: 'Service account not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
      return new Response(JSON.stringify({ error: 'Release not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tracks = release.tracks || [];

    // Apply fixes
    for (const fix of trackFixes) {
      const { trackIndex, mp3Url, wavUrl } = fix;
      if (trackIndex >= 0 && trackIndex < tracks.length) {
        if (mp3Url !== undefined) tracks[trackIndex].mp3Url = mp3Url;
        if (wavUrl !== undefined) tracks[trackIndex].wavUrl = wavUrl;
      }
    }

    // Convert tracks array to Firestore format
    const tracksFirestore = tracks.map((track: any) => ({
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

    const patchResponse = await fetch(docUrl, {
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
    });

    if (!patchResponse.ok) {
      const errorData = await patchResponse.json();
      return new Response(JSON.stringify({
        error: 'Failed to update',
        details: errorData
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Track URLs updated',
      releaseId,
      updatedTracks: trackFixes.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
