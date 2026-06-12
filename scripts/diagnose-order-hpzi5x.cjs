// Diagnose missing side effects for order FW-260611-HPZI5X
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
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}
function pv(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = pv(x); return o; }
  if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
  return v;
}
async function query(tok, collection, field, value, limit = 5) {
  const q = { structuredQuery: { from: [{ collectionId: collection }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } }, limit } };
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const d = await r.json();
  const out = [];
  for (const it of d) {
    if (!it.document) continue;
    const f = {};
    for (const [k, v] of Object.entries(it.document.fields || {})) f[k] = pv(v);
    f._docId = it.document.name.split('/').pop();
    out.push(f);
  }
  return out;
}
(async () => {
  const tok = await getToken();
  const ORDER_ID = 'udSgfneZT3RUUrycCjif';
  const ORDER_NUM = 'FW-260611-HPZI5X';
  const RELEASE_ID = 'hangry_records_FW-1780739181417';
  const ARTIST_ID = 'dW3n7mwOiqgDnODGvPs7fXbgIbo1';

  // 1. Release vinylParts state
  const rr = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${RELEASE_ID}?mask.fieldPaths=vinylParts&mask.fieldPaths=vinylStock`, { headers: { Authorization: `Bearer ${tok}` } });
  const rel = await rr.json();
  const parts = pv(rel.fields?.vinylParts);
  console.log('=== vinylParts state ===');
  (parts || []).forEach((p, i) => console.log(`  [${i}] ${p.name}: stock=${p.stock} reserved=${p.reserved ?? 'n/a'} sold=${p.sold ?? 'n/a'} pressed=${p.pressed} price=${p.price} trackNumbers=${JSON.stringify(p.trackNumbers)}`));
  console.log('  vinylStock (legacy):', pv(rel.fields?.vinylStock));

  // 2. vinyl-stock-movements for order
  console.log('=== vinyl-stock-movements (by orderId) ===');
  const movements = await query(tok, 'vinyl-stock-movements', 'orderId', ORDER_ID);
  console.log(movements.length ? JSON.stringify(movements, null, 2) : '  NONE');

  // 3. pendingPayouts for order
  console.log('=== pendingPayouts (by orderId) ===');
  const payouts = await query(tok, 'pendingPayouts', 'orderId', ORDER_ID);
  console.log(payouts.length ? JSON.stringify(payouts, null, 2) : '  NONE');

  // 4. salesLedger (Firebase) by orderId
  console.log('=== salesLedger (by orderId) ===');
  const ledger = await query(tok, 'salesLedger', 'orderId', ORDER_ID);
  console.log(ledger.length ? JSON.stringify(ledger, null, 2) : '  NONE');

  // 5. Artist account doc (pendingBalance)
  console.log('=== artists doc (Hangry) ===');
  const ar = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${ARTIST_ID}`, { headers: { Authorization: `Bearer ${tok}` } });
  const artist = await ar.json();
  if (artist.fields) {
    const f = {};
    for (const [k, v] of Object.entries(artist.fields)) f[k] = pv(v);
    console.log(JSON.stringify({ artistName: f.artistName, email: f.email, pendingBalance: f.pendingBalance, totalEarnings: f.totalEarnings }, null, 2));
  } else {
    console.log('  artists/' + ARTIST_ID + ' NOT FOUND:', JSON.stringify(artist.error || artist).slice(0, 200));
  }

  // 6. Stock reservations for this release
  console.log('=== stockReservations (by releaseId) ===');
  const reservations = await query(tok, 'stockReservations', 'releaseId', RELEASE_ID);
  console.log(reservations.length ? JSON.stringify(reservations, null, 2) : '  NONE');
})().catch(e => { console.error(e); process.exit(1); });
