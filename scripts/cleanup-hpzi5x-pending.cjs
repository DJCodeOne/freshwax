// Delete the consumed pendingCheckouts doc for order FW-260611-HPZI5X and
// print the final repaired order items/shipping for verification.
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
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
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
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = pv(x); return o; }
  if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
  return v;
}
(async () => {
  const tok = await getToken();
  const del = await fetch(`${BASE}/pendingCheckouts/i06Vrlh55kdBr62s2uCQ`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  console.log('pendingCheckouts/i06Vrlh55kdBr62s2uCQ delete:', del.status);
  const r = await fetch(`${BASE}/orders/udSgfneZT3RUUrycCjif`, { headers: { Authorization: `Bearer ${tok}` } });
  const d = await r.json();
  const f = {};
  for (const [k, v] of Object.entries(d.fields || {})) f[k] = pv(v);
  console.log(JSON.stringify({ items: f.items, shipping: f.shipping, totals: f.totals, status: f.status }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
