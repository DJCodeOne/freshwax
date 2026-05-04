// Persist the current FreshWax PayPal balance to a `treasury` Firestore
// doc with timestamp + delta from previous. Lets the admin dashboard
// (or future reconciliation runs) read the latest known balance without
// having to be told it on the command line each time.
//
// Usage:  node scripts/record-treasury-balance.cjs <newBalanceGBP> [note]
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

const NEW_BALANCE = parseFloat(process.argv[2]);
const NOTE = process.argv.slice(3).join(' ') || null;
if (Number.isNaN(NEW_BALANCE)) {
  console.error('Usage: node scripts/record-treasury-balance.cjs <balanceGBP> [note]');
  process.exit(1);
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

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
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return { timestampValue: v };
    return { stringValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/treasury/paypal`;

  // Read current to capture previous-balance metadata
  let previous = null;
  try {
    const cr = await fetch(docUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (cr.ok) {
      const j = await cr.json();
      previous = Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
    }
  } catch (_) { /* missing doc is fine */ }

  const nowISO = new Date().toISOString();
  const delta = previous && typeof previous.balance === 'number' ? Math.round((NEW_BALANCE - previous.balance) * 100) / 100 : null;
  const fields = {
    balance: NEW_BALANCE,
    currency: 'GBP',
    recordedAt: nowISO,
    previousBalance: previous && typeof previous.balance === 'number' ? previous.balance : null,
    previousRecordedAt: previous && previous.recordedAt ? previous.recordedAt : null,
    delta,
    note: NOTE,
  };

  const fsFields = {};
  for (const [k, v] of Object.entries(fields)) fsFields[k] = toFsValue(v);

  const w = await fetch(docUrl, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fsFields }),
  });
  if (!w.ok) { console.error('PATCH failed:', w.status, await w.text()); process.exit(1); }

  console.log(`Recorded treasury/paypal:`);
  console.log(`  balance:        £${NEW_BALANCE.toFixed(2)}`);
  console.log(`  recordedAt:     ${nowISO}`);
  if (previous && typeof previous.balance === 'number') {
    console.log(`  previous:       £${previous.balance.toFixed(2)} (at ${previous.recordedAt || '?'})`);
    console.log(`  delta:          £${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
  } else {
    console.log(`  (no prior record — this is the first snapshot)`);
  }
  if (NOTE) console.log(`  note:           ${NOTE}`);

  // Append to history subcollection so we have an audit trail
  const histId = nowISO.replace(/[:.]/g, '-');
  const histUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/treasury/paypal/history/${histId}`;
  const histFields = {
    balance: NEW_BALANCE,
    currency: 'GBP',
    recordedAt: nowISO,
    delta,
    note: NOTE,
  };
  const hf = {};
  for (const [k, v] of Object.entries(histFields)) hf[k] = toFsValue(v);
  await fetch(histUrl, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: hf }),
  });
  console.log(`  history entry:  treasury/paypal/history/${histId}`);
})().catch(e => { console.error(e); process.exit(1); });
