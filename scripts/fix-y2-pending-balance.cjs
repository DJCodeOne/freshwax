// One-off: fix Y2's stale pendingBalance to match pendingPayouts truth.
// Y2 - Danger Chamber's Jan 26 PayPal order had pendingPayouts manually
// corrected from £6.144 (Stripe-formula) to £5.95 (actual PayPal fee)
// but artists.pendingBalance was never updated. Drop by £0.194.
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

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const ARTIST_ID = 'BNpWXqfKDoOCXHKN2IqfxWcHtBv2';
const EXPECTED_BEFORE = 6.144;
const TARGET = 5.95;
const DELTA = TARGET - EXPECTED_BEFORE; // -0.194

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function parseVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue) { const o = {}; for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = parseVal(val); return o; }
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseVal);
  return null;
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${ARTIST_ID}`;
  const r = await fetch(docUrl, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  const doc = Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
  const current = Number(doc.pendingBalance || 0);

  console.log(`Artist:           ${doc.artistName || doc.displayName || doc.name}`);
  console.log(`Current balance:  £${current.toFixed(4)}`);
  console.log(`Target balance:   £${TARGET.toFixed(4)}`);
  console.log(`Delta:            £${(TARGET - current).toFixed(4)}`);

  if (Math.abs(current - TARGET) < 0.001) {
    console.log('Already correct, nothing to do.');
    return;
  }
  if (Math.abs(current - EXPECTED_BEFORE) > 0.01) {
    console.log(`\nWARNING: current balance £${current.toFixed(4)} doesn't match expected pre-fix value £${EXPECTED_BEFORE}. Aborting to avoid overcorrection.`);
    return;
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  // Use commit/transactional commit for atomic increment
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
  const commitBody = {
    writes: [
      {
        transform: {
          document: `projects/${PROJECT_ID}/databases/(default)/documents/artists/${ARTIST_ID}`,
          fieldTransforms: [
            { fieldPath: 'pendingBalance', increment: { doubleValue: DELTA } }
          ]
        }
      }
    ]
  };
  const w = await fetch(commitUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(commitBody) });
  if (!w.ok) {
    console.error('Commit failed:', w.status, await w.text());
    process.exit(1);
  }

  // Re-read to verify
  const r2 = await fetch(docUrl, { headers: { Authorization: 'Bearer ' + token } });
  const j2 = await r2.json();
  const doc2 = Object.fromEntries(Object.entries(j2.fields || {}).map(([k, v]) => [k, parseVal(v)]));
  console.log(`\nNew balance:      £${Number(doc2.pendingBalance || 0).toFixed(4)}`);
})().catch(e => { console.error(e); process.exit(1); });
