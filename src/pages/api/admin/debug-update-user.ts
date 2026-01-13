// src/pages/api/admin/debug-update-user.ts
// Debug endpoint to directly update user roles with verbose logging

import type { APIRoute } from 'astro';

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

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') || 'JueT7q9eKjQk4iFRg2tXa4ZP8642';
  const confirm = url.searchParams.get('confirm');

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
    const token = await getToken(serviceAccountKey);
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;

    // First, GET the current document
    const getResponse = await fetch(docUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const currentDoc = await getResponse.json() as any;

    // Extract current roles
    const currentRoles: any = {};
    const rolesField = currentDoc.fields?.roles?.mapValue?.fields || {};
    for (const [k, v] of Object.entries(rolesField) as any) {
      currentRoles[k] = v.booleanValue;
    }

    if (confirm !== 'yes') {
      return new Response(JSON.stringify({
        message: 'Current state (add &confirm=yes to update)',
        userId,
        currentRoles,
        willSetArtistTo: false
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build new roles with artist=false
    const newRoles = { ...currentRoles, artist: false };

    // Build Firestore value for roles map
    const rolesMapFields: any = {};
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

    const patchResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patchBody)
    });

    const patchResult = await patchResponse.json();

    if (!patchResponse.ok) {
      return new Response(JSON.stringify({
        error: 'PATCH failed',
        status: patchResponse.status,
        result: patchResult
      }, null, 2), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify by fetching again
    const verifyResponse = await fetch(docUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const verifyDoc = await verifyResponse.json() as any;

    const verifyRoles: any = {};
    const verifyRolesField = verifyDoc.fields?.roles?.mapValue?.fields || {};
    for (const [k, v] of Object.entries(verifyRolesField) as any) {
      verifyRoles[k] = v.booleanValue;
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Update complete',
      before: currentRoles,
      requested: newRoles,
      after: verifyRoles,
      artistNowFalse: verifyRoles.artist === false
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
