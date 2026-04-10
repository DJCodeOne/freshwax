// One-shot: reorder tracks for a release
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
  return await r.json();
}

async function patchDoc(token, col, id, fields, mask) {
  const params = new URLSearchParams();
  for (const p of mask) params.append('updateMask.fieldPaths', p);
  const r = await fetch(`${FB}/${col}/${encodeURIComponent(id)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`patch failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

(async () => {
  const releaseId = 'code_one_bakkus_FW-1775817379627';
  const desiredOrder = ['Warrior', 'The Relic', 'Dark Space', 'Back In The Jungle'];

  const token = await getToken();
  const doc = await getDoc(token, 'releases', releaseId);
  const tracks = doc.fields.tracks.arrayValue.values;

  console.log('Current order:');
  tracks.forEach((t, i) => {
    const name = t.mapValue.fields.trackName?.stringValue || '?';
    console.log(`  ${i + 1}. ${name}`);
  });

  // Reorder
  const reordered = [];
  for (const desired of desiredOrder) {
    const found = tracks.find(t => {
      const name = (t.mapValue.fields.trackName?.stringValue || '').toLowerCase();
      return name.includes(desired.toLowerCase());
    });
    if (found) {
      // Update trackNumber
      found.mapValue.fields.trackNumber = { integerValue: String(reordered.length + 1) };
      found.mapValue.fields.displayTrackNumber = { integerValue: String(reordered.length + 1) };
      reordered.push(found);
    } else {
      console.error(`  ! Track not found: ${desired}`);
    }
  }

  if (reordered.length !== tracks.length) {
    console.error('Track count mismatch! Aborting.');
    return;
  }

  console.log('\nNew order:');
  reordered.forEach((t, i) => {
    const name = t.mapValue.fields.trackName?.stringValue || '?';
    console.log(`  ${i + 1}. ${name}`);
  });

  await patchDoc(token, 'releases', releaseId, {
    tracks: { arrayValue: { values: reordered } },
    updatedAt: { stringValue: new Date().toISOString() },
  }, ['tracks', 'updatedAt']);

  console.log('\n✓ Track order updated in Firestore');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
