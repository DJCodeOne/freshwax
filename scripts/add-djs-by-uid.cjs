// scripts/add-djs-by-uid.cjs
// Add specific users (by UID) to djLobbyBypass + roles.djEligible.
// Useful for partners who don't have an entry in the `artists` collection
// but should still appear in the admin/streaming approved DJ list.
//
// Usage:  node scripts/add-djs-by-uid.cjs <uid1> [uid2] ...

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}

const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function getDoc(token, col, id) {
  const r = await fetch(`${FB}/${col}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get ${col}/${id} ${r.status}`);
  return await r.json();
}

async function setDoc(token, col, id, fields) {
  const r = await fetch(`${FB}/${col}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`set ${col}/${id} ${r.status} ${await r.text()}`);
}

async function patchDoc(token, col, id, fields, mask) {
  const params = new URLSearchParams();
  for (const p of mask) params.append('updateMask.fieldPaths', p);
  const r = await fetch(`${FB}/${col}/${encodeURIComponent(id)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`patch ${col}/${id} ${r.status} ${await r.text()}`);
}

function s(v) { return v?.stringValue || ''; }

(async () => {
  const uids = process.argv.slice(2);
  if (uids.length === 0) {
    console.log('Usage: node scripts/add-djs-by-uid.cjs <uid1> [uid2] ...');
    process.exit(1);
  }

  const token = await getToken();
  const nowIso = new Date().toISOString();

  for (const uid of uids) {
    console.log(`\n=== ${uid} ===`);
    try {
      const userDoc = await getDoc(token, 'users', uid);
      if (!userDoc) {
        console.log(`  ! users/${uid} not found, skipping`);
        continue;
      }
      const f = userDoc.fields || {};
      const email = s(f.email);
      const name = s(f.displayName) || s(f.artistName) || s(f.name) || email.split('@')[0] || 'Unknown';

      // 1. Upsert djLobbyBypass
      const existing = await getDoc(token, 'djLobbyBypass', uid);
      if (existing) {
        console.log(`  ✓ djLobbyBypass already exists for ${name}`);
      } else {
        await setDoc(token, 'djLobbyBypass', uid, {
          email: { stringValue: email },
          name: { stringValue: name },
          reason: { stringValue: 'Manually added partner' },
          grantedAt: { stringValue: nowIso },
          grantedBy: { stringValue: 'add-djs-by-uid script' },
        });
        console.log(`  + djLobbyBypass created for ${name} (${email})`);
      }

      // 2. Set roles.djEligible = true
      const existingRoles = f.roles?.mapValue?.fields || {};
      if (existingRoles.djEligible?.booleanValue === true) {
        console.log(`  ✓ roles.djEligible already true`);
      } else {
        const merged = { ...existingRoles, djEligible: { booleanValue: true } };
        await patchDoc(token, 'users', uid, {
          roles: { mapValue: { fields: merged } },
          updatedAt: { stringValue: nowIso },
        }, ['roles', 'updatedAt']);
        console.log(`  + roles.djEligible set to true`);
      }
    } catch (err) {
      console.error(`  ! ERROR: ${err.message}`);
    }
  }
})();
