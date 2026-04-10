// scripts/sync-bypass-to-djeligible.cjs
// One-shot: read all djLobbyBypass entries and ensure each user has
// roles.djEligible = true on their users/{uid} document so the bypassed
// DJs appear in the canonical approved DJ list.
//
// Usage:  node scripts/sync-bypass-to-djeligible.cjs

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// --- Load .env ---
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const RAW_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!CLIENT_EMAIL || !RAW_PRIVATE_KEY) {
  console.error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in .env');
  process.exit(1);
}

// Normalise private key (handles literal \n in .env)
const PRIVATE_KEY = RAW_PRIVATE_KEY.replace(/\\n/g, '\n');

// --- Service account JWT → OAuth2 access token ---
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const claimB64 = base64url(JSON.stringify(claim));
  const signingInput = `${headerB64}.${claimB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(PRIVATE_KEY).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token;
}

// --- Firestore helpers ---
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function listCollection(token, collection) {
  const docs = [];
  let pageToken = null;
  do {
    const url = `${FIRESTORE_BASE}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      throw new Error(`List ${collection} failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    for (const d of data.documents || []) {
      docs.push({
        id: d.name.split('/').pop(),
        fields: d.fields || {},
      });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

async function getDoc(token, collection, docId) {
  const url = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Get ${collection}/${docId} failed: ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

// PATCH with updateMask, supports nested keys via dotted paths
async function patchDoc(token, collection, docId, fieldsValue, maskPaths) {
  const params = new URLSearchParams();
  for (const p of maskPaths) params.append('updateMask.fieldPaths', p);
  const url = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}?${params.toString()}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: fieldsValue }),
  });
  if (!resp.ok) {
    throw new Error(`Patch ${collection}/${docId} failed: ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

// --- Run ---
(async () => {
  console.log('Fetching service account access token...');
  const token = await getAccessToken();
  console.log('Listing djLobbyBypass collection...');
  const bypasses = await listCollection(token, 'djLobbyBypass');
  console.log(`Found ${bypasses.length} bypassed users.\n`);

  if (bypasses.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  let updated = 0;
  let alreadyEligible = 0;
  let missing = 0;
  let errors = 0;
  const nowIso = new Date().toISOString();

  for (const bypass of bypasses) {
    const uid = bypass.id;
    const email = bypass.fields.email?.stringValue || '?';
    const name = bypass.fields.name?.stringValue || '?';

    try {
      const userDoc = await getDoc(token, 'users', uid);
      if (!userDoc) {
        console.log(`  - ${uid} (${name} / ${email}) → users doc MISSING, skipping`);
        missing++;
        continue;
      }

      const existingRoles = userDoc.fields?.roles?.mapValue?.fields || {};
      const alreadyDjEligible = existingRoles.djEligible?.booleanValue === true;

      if (alreadyDjEligible) {
        console.log(`  ✓ ${uid} (${name}) → already djEligible`);
        alreadyEligible++;
        continue;
      }

      // Build merged roles map preserving existing role flags
      const mergedRoles = { ...existingRoles, djEligible: { booleanValue: true } };

      const update = {
        roles: {
          mapValue: { fields: mergedRoles },
        },
        updatedAt: { stringValue: nowIso },
      };

      await patchDoc(token, 'users', uid, update, ['roles', 'updatedAt']);
      console.log(`  + ${uid} (${name}) → set roles.djEligible = true`);
      updated++;
    } catch (err) {
      console.error(`  ! ${uid} (${name}) → ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Total bypassed users:   ${bypasses.length}`);
  console.log(`  Newly approved:         ${updated}`);
  console.log(`  Already djEligible:     ${alreadyEligible}`);
  console.log(`  Missing user docs:      ${missing}`);
  console.log(`  Errors:                 ${errors}`);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
