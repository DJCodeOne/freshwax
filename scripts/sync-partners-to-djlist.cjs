// scripts/sync-partners-to-djlist.cjs
// Take every approved partner from the `artists` collection and:
//   1. Upsert a djLobbyBypass doc so they show up in admin/streaming
//      "Approved DJs" list (which is built from djLobbyBypass).
//   2. Set users/{uid}.roles.djEligible = true so the canonical
//      role flag is in sync.
//
// Skips artists that are missing approval, missing a users doc, or
// already have both flags set.
//
// Usage: node scripts/sync-partners-to-djlist.cjs

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// --- .env loader ---
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
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
  console.error('Missing FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env');
  process.exit(1);
}
const PRIVATE_KEY = RAW_PRIVATE_KEY.replace(/\\n/g, '\n');

// --- JWT → access token ---
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
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).access_token;
}

// --- Firestore helpers ---
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function listCollection(token, collection) {
  const docs = [];
  let pageToken = null;
  do {
    const url = `${FIRESTORE_BASE}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`List ${collection} failed: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    for (const d of data.documents || []) {
      docs.push({ id: d.name.split('/').pop(), fields: d.fields || {} });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

async function getDoc(token, collection, docId) {
  const url = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Get ${collection}/${docId} failed: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

async function setDoc(token, collection, docId, fields) {
  const url = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Set ${collection}/${docId} failed: ${resp.status} ${await resp.text()}`);
}

async function patchDoc(token, collection, docId, fields, maskPaths) {
  const params = new URLSearchParams();
  for (const p of maskPaths) params.append('updateMask.fieldPaths', p);
  const url = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}?${params.toString()}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Patch ${collection}/${docId} failed: ${resp.status} ${await resp.text()}`);
}

// --- Helpers ---
function strVal(v) { return v?.stringValue || ''; }
function boolVal(v) { return v?.booleanValue === true; }

// --- Run ---
(async () => {
  console.log('Fetching service account access token...');
  const token = await getAccessToken();

  console.log('Listing artists collection...');
  const artists = await listCollection(token, 'artists');
  console.log(`Found ${artists.length} artists.\n`);

  // Filter to approved partners only
  const approved = artists.filter((a) => {
    const f = a.fields;
    return boolVal(f.approved) || strVal(f.status) === 'approved';
  });
  console.log(`${approved.length} of those are approved partners.\n`);

  let bypassCreated = 0;
  let bypassExisted = 0;
  let djEligibleSet = 0;
  let djEligibleAlready = 0;
  let userMissing = 0;
  let errors = 0;
  const nowIso = new Date().toISOString();

  for (const artist of approved) {
    const uid = artist.id;
    const f = artist.fields;
    const email = strVal(f.email);
    const name =
      strVal(f.displayName) ||
      strVal(f.artistName) ||
      strVal(f.name) ||
      email.split('@')[0] ||
      'Unknown';

    try {
      // 1. Upsert djLobbyBypass entry so admin/streaming sees them
      const existingBypass = await getDoc(token, 'djLobbyBypass', uid);
      if (existingBypass) {
        console.log(`  ✓ ${uid} (${name}) → djLobbyBypass already exists`);
        bypassExisted++;
      } else {
        await setDoc(token, 'djLobbyBypass', uid, {
          email: { stringValue: email },
          name: { stringValue: name },
          reason: { stringValue: 'Auto-approved partner' },
          grantedAt: { stringValue: nowIso },
          grantedBy: { stringValue: 'sync-partners-script' },
        });
        console.log(`  + ${uid} (${name}) → djLobbyBypass created`);
        bypassCreated++;
      }

      // 2. Set users/{uid}.roles.djEligible = true (canonical role flag)
      const userDoc = await getDoc(token, 'users', uid);
      if (!userDoc) {
        console.log(`    - users doc missing, skipping role update`);
        userMissing++;
        continue;
      }

      const existingRoles = userDoc.fields?.roles?.mapValue?.fields || {};
      if (existingRoles.djEligible?.booleanValue === true) {
        console.log(`    ✓ users.roles.djEligible already true`);
        djEligibleAlready++;
        continue;
      }

      const mergedRoles = { ...existingRoles, djEligible: { booleanValue: true } };
      await patchDoc(token, 'users', uid, {
        roles: { mapValue: { fields: mergedRoles } },
        updatedAt: { stringValue: nowIso },
      }, ['roles', 'updatedAt']);
      console.log(`    + users.roles.djEligible set to true`);
      djEligibleSet++;
    } catch (err) {
      console.error(`  ! ${uid} (${name}) → ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Approved partners scanned:   ${approved.length}`);
  console.log(`  djLobbyBypass created:       ${bypassCreated}`);
  console.log(`  djLobbyBypass already set:   ${bypassExisted}`);
  console.log(`  roles.djEligible set:        ${djEligibleSet}`);
  console.log(`  roles.djEligible already:    ${djEligibleAlready}`);
  console.log(`  users doc missing:           ${userMissing}`);
  console.log(`  Errors:                      ${errors}`);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
