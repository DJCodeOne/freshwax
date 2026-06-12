// Adjust order FW-260611-HPZI5X account records to the ACTUAL Stripe fee.
// Stripe charged £0.58 (balance transaction), not the £0.41/£0.48 estimates.
// Model: Hangry receives £4.99 postage in full + £15.00 - £0.58 - £0.15 (1%).
//   pendingPayouts:    amount 19.43 -> 19.26, itemAmount 14.44 -> 14.27
//   artists balance:   pendingBalance -0.17
//   salesLedger (FS):  stripeFee 0.58, totalFees 0.73, netRevenue/payout 14.27
//   sales_ledger (D1): same (prints SQL file)
//   order totals:      stripeFee 0.58, serviceFees 0.73
// Usage: node scripts/adjust-hpzi5x-actual-fee.cjs --apply
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
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const ORDER_DOC = 'udSgfneZT3RUUrycCjif';
const LEDGER_DOC = 'IUwTAkoon4vWzfxLV3Gy';
const PAYOUT_DOC = 'neWI4uN4KDTMH1NS7Uf6';
const ARTIST_ID = 'dW3n7mwOiqgDnODGvPs7fXbgIbo1';

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}
function toFv(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toFv) } };
  if (typeof x === 'object') { const fields = {}; for (const [k, v] of Object.entries(x)) fields[k] = toFv(v); return { mapValue: { fields } }; }
  throw new Error('unsupported');
}
async function patchFields(tok, p, obj) {
  const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('.');
    if (parts.length === 1) { fields[k] = toFv(v); }
  }
  const body = { fields: {} };
  // Build nested structure for dotted paths
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('.');
    let cur = body.fields;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || { mapValue: { fields: {} } };
      cur = cur[parts[i]].mapValue.fields;
    }
    cur[parts[parts.length - 1]] = toFv(v);
  }
  const r = await fetch(`${BASE}/${p}?${mask}`, { method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (d.error) throw new Error(`patch ${p}: ${d.error.message}`);
}
async function incrementField(tok, docPath, field, by) {
  const r = await fetch(`${BASE.replace('/documents', '')}/documents:commit`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{ transform: { document: `projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`, fieldTransforms: [{ fieldPath: field, increment: { doubleValue: by } }] } }] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`increment: ${d.error.message}`);
}

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log('Hangry payout: 4.99 postage + (15.00 - 0.58 actual Stripe - 0.15 FW 1%) = 19.26 (was 19.43, delta -0.17)');
  if (!APPLY) { console.log('Re-run with --apply'); return; }
  const tok = await getToken();
  const nowIso = new Date().toISOString();

  await patchFields(tok, `pendingPayouts/${PAYOUT_DOC}`, {
    amount: 19.26, itemAmount: 14.27, updatedAt: nowIso,
    feeNote: 'Adjusted to actual Stripe fee £0.58 (balance transaction txn for pi_3ThILTIDZxi2HzfN1S6UFHeg); was £0.41 estimate',
  });
  console.log('✓ pendingPayouts 19.43 -> 19.26');

  await incrementField(tok, `artists/${ARTIST_ID}`, 'pendingBalance', -0.17);
  console.log('✓ artists.pendingBalance -0.17 (19.43 -> 19.26)');

  await patchFields(tok, `salesLedger/${LEDGER_DOC}`, {
    stripeFee: 0.58, totalFees: 0.73, netRevenue: 14.27, artistPayout: 14.27, correctedAt: nowIso,
  });
  console.log('✓ salesLedger stripeFee 0.58 / net 14.27');

  await patchFields(tok, `orders/${ORDER_DOC}`, {
    'totals.stripeFee': 0.58, 'totals.serviceFees': 0.73, updatedAt: nowIso,
  });
  console.log('✓ order totals stripeFee 0.58 / serviceFees 0.73');

  const sql = `UPDATE sales_ledger SET stripe_fee = 0.58, total_fees = 0.73, net_revenue = 14.27, artist_payout = 14.27, corrected_at = '${nowIso}', data = json_set(data, '$.stripeFee', 0.58, '$.totalFees', 0.73, '$.netRevenue', 14.27, '$.artistPayout', 14.27) WHERE id = '${LEDGER_DOC}';`;
  fs.writeFileSync(path.resolve(__dirname, 'adjust-hpzi5x-actual-fee.sql'), sql);
  console.log('✓ wrote scripts/adjust-hpzi5x-actual-fee.sql');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
