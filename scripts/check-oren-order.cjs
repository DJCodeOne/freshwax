// Look up Oren's most recent orders + dump item shape so we can see why
// the single-track lookup fell through to the all-tracks fallback.
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
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const UID = 'DCqfp6pfFhh7XOcSQ4P5xPmmUBg1';

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}
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
  const token = await getToken();
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const q = {
    structuredQuery: {
      from: [{ collectionId: 'orders' }],
      where: { fieldFilter: { field: { fieldPath: 'customer.userId' }, op: 'EQUAL', value: { stringValue: UID } } },
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      limit: 5,
    },
  };
  const res = await fetch(FB, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const arr = await res.json();
  if (!Array.isArray(arr)) { console.log('Bad response:', JSON.stringify(arr).slice(0, 500)); return; }

  for (const row of arr) {
    if (!row.document) continue;
    const f = row.document.fields || {};
    const items = parseVal(f.items) || [];
    console.log('====================');
    console.log('Order ID:', row.document.name.split('/').pop());
    console.log('Number:', parseVal(f.orderNumber));
    console.log('Total:', parseVal(f.total));
    console.log('Status:', parseVal(f.status));
    console.log('Created:', parseVal(f.createdAt));
    for (const item of items) {
      console.log('---');
      console.log('  name:', item.name);
      console.log('  type:', item.type, 'format:', item.format);
      console.log('  releaseId:', item.releaseId);
      console.log('  trackId:', item.trackId);
      console.log('  title:', item.title);
      console.log('  artist:', item.artist);
      console.log('  price:', item.price);
      const tracks = item.downloads?.tracks || [];
      console.log('  downloads.tracks count:', tracks.length);
      tracks.forEach((t, i) => console.log(`    [${i}] ${t.name}`));
    }
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
