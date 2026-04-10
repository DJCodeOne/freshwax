// Fix missing customer.userId on order
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

const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

(async () => {
  const orderId = process.argv[2] || '2B006Z3eOtImweJpFOKD';
  const userId = process.argv[3] || '8WmxYeCp4PSym5iWHahgizokn5F2';

  const tok = await getToken();

  // Get current order to preserve existing customer fields
  const getR = await fetch(`${FB}/orders/${orderId}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!getR.ok) throw new Error('Get order failed: ' + getR.status);
  const doc = await getR.json();
  const existingCustomer = doc.fields?.customer?.mapValue?.fields || {};

  // Merge userId into existing customer fields
  existingCustomer.userId = { stringValue: userId };

  const url = `${FB}/orders/${orderId}?updateMask.fieldPaths=customer`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { customer: { mapValue: { fields: existingCustomer } } } })
  });
  if (!r.ok) throw new Error('Patch failed: ' + r.status + ' ' + await r.text());
  console.log('Updated order', orderId, 'customer.userId =', userId);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
