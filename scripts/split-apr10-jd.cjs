// Retroactively apply the Jungle Disorder 50/50 payoutSplit to order
// FW-260410-EL5XI2 (doc id 2B006Z3eOtImweJpFOKD, £4 PayPal, 1 item: full
// JD EP). Currently Bakkus has 100% (£3.704). Should be £1.852 each to
// Bakkus (CCMDrCWRkUXiPN7O83iSfm1BxGo1) and Code One (8WmxYeCp4PSym5iWHahgizokn5F2).
//
// Mirrors the payoutSplits handling now done at order-creation time —
// see `lib/order/seller-payments/artist-payments.ts`.
//
// Idempotent via `splitApplied:true` flags on the rows; re-runs are no-ops.
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

const ORDER_ID = '2B006Z3eOtImweJpFOKD';
const ORDER_NUMBER = 'FW-260410-EL5XI2';
const PENDING_PAYOUT_ID = 'o6ngUP22MBZjJtZLFZaC';
const LEDGER_ID = 'ledger_2B006Z3eOtImweJpFOKD_1BxGo1';
const BAKKUS_ID = 'CCMDrCWRkUXiPN7O83iSfm1BxGo1';
const CODE_ONE_ID = '8WmxYeCp4PSym5iWHahgizokn5F2';

const TOTAL_ARTIST_PAYOUT = 3.704; // current Bakkus row
// Use 4dp halves so they sum exactly to the original (matches how
// artists.pendingBalance stores values — eg £8.2484, £5.4360).
const BAKKUS_NEW = Math.round((TOTAL_ARTIST_PAYOUT / 2) * 10000) / 10000; // 1.852
const CODE_ONE_NEW = Math.round((TOTAL_ARTIST_PAYOUT - BAKKUS_NEW) * 10000) / 10000; // 1.852

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
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  return (await tr.json()).access_token;
}
async function getDoc(token, col, id) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}/${id}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
}
async function patchDoc(token, col, id, fields) {
  const params = new URLSearchParams();
  for (const k of Object.keys(fields)) params.append('updateMask.fieldPaths', k);
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = toFsValue(v);
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}/${id}?${params.toString()}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: out })
  });
  if (!r.ok) throw new Error(`patch ${col}/${id}: ${r.status} ${await r.text()}`);
}
async function setDoc(token, col, id, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = toFsValue(v);
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}/${id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: out })
  });
  if (!r.ok) throw new Error(`set ${col}/${id}: ${r.status} ${await r.text()}`);
}
async function commitIncrement(token, col, id, field, delta) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
  const w = await fetch(url, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{
      transform: {
        document: `projects/${PROJECT_ID}/databases/(default)/documents/${col}/${id}`,
        fieldTransforms: [{ fieldPath: field, increment: { doubleValue: delta } }]
      }
    }] })
  });
  if (!w.ok) throw new Error(`increment ${col}/${id}.${field}: ${w.status} ${await w.text()}`);
}

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Splitting £${TOTAL_ARTIST_PAYOUT} 50/50:  Bakkus £${BAKKUS_NEW}  +  Code One £${CODE_ONE_NEW}\n`);

  const token = await getToken();

  // Idempotency: short-circuit if the existing row is already at the half value.
  const existing = await getDoc(token, 'pendingPayouts', PENDING_PAYOUT_ID);
  if (existing && existing.splitApplied === true) {
    console.log('Already split — splitApplied flag is true. Nothing to do.');
    return;
  }
  if (Math.abs(Number(existing.amount || 0) - TOTAL_ARTIST_PAYOUT) > 0.01) {
    console.log(`WARN: existing pendingPayout amount £${existing.amount} doesn't match expected £${TOTAL_ARTIST_PAYOUT}. Aborting.`);
    return;
  }

  const codeOnePayoutId = `${PENDING_PAYOUT_ID}_codeone`;
  const codeOneLedgerId = `ledger_${ORDER_ID}_okn5F2`;

  console.log('Plan:');
  console.log(`  1. pendingPayouts/${PENDING_PAYOUT_ID}: amount £${TOTAL_ARTIST_PAYOUT} → £${BAKKUS_NEW} (Bakkus, splitApplied=true)`);
  console.log(`  2. pendingPayouts/${codeOnePayoutId}: NEW (Code One £${CODE_ONE_NEW}, splitApplied=true)`);
  console.log(`  3. salesLedger/${LEDGER_ID}: artistPayout £${TOTAL_ARTIST_PAYOUT} → £${BAKKUS_NEW}, gross £4 → £2`);
  console.log(`  4. salesLedger/${codeOneLedgerId}: NEW (Code One half, items=[] split-recipient)`);
  console.log(`  5. artists/${BAKKUS_ID}.pendingBalance: -£${(TOTAL_ARTIST_PAYOUT - BAKKUS_NEW).toFixed(4)}`);
  console.log(`  6. artists/${CODE_ONE_ID}.pendingBalance: +£${CODE_ONE_NEW.toFixed(4)}`);

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return; }

  const nowISO = new Date().toISOString();
  const splitNote = `Retroactive 50/50 split applied via Jungle Disorder payoutSplits (${nowISO})`;

  // 1. Update existing Bakkus row
  await patchDoc(token, 'pendingPayouts', PENDING_PAYOUT_ID, {
    amount: BAKKUS_NEW,
    splitApplied: true,
    splitNote,
    updatedAt: nowISO,
  });
  console.log('1. Bakkus pendingPayout updated.');

  // 2. Create new Code One row
  await setDoc(token, 'pendingPayouts', codeOnePayoutId, {
    orderId: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    sellerId: CODE_ONE_ID,
    artistId: CODE_ONE_ID,
    artistName: 'Code One',
    artistEmail: 'davidhagon@gmail.com',
    amount: CODE_ONE_NEW,
    currency: 'gbp',
    customerPaymentMethod: 'paypal',
    status: 'pending',
    splitApplied: true,
    splitNote,
    createdAt: '2026-04-10T11:17:21.348Z',
    updatedAt: nowISO,
  });
  console.log('2. Code One pendingPayout created.');

  // 3. Update existing Bakkus salesLedger entry
  await patchDoc(token, 'salesLedger', LEDGER_ID, {
    subtotal: 2,
    grossTotal: 2,
    artistPayout: BAKKUS_NEW,
    netRevenue: BAKKUS_NEW,
    paypalFee: 0.13, // half of (£0.42)
    freshWaxFee: 0.02, // half of £0.04
    totalFees: 0.15,
    splitApplied: true,
    splitNote,
  });
  console.log('3. Bakkus salesLedger updated.');

  // 4. Create new Code One ledger entry
  await setDoc(token, 'salesLedger', codeOneLedgerId, {
    orderId: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    timestamp: '2026-04-10T11:17:21.348Z',
    year: 2026, month: 4, day: 10,
    customerId: null,
    customerEmail: 'davidhagon@gmail.com',
    customerName: null,
    artistId: CODE_ONE_ID,
    artistName: 'Code One',
    submitterId: CODE_ONE_ID,
    submitterEmail: 'davidhagon@gmail.com',
    subtotal: 2,
    shipping: 0,
    discount: 0,
    grossTotal: 2,
    stripeFee: 0,
    paypalFee: 0.13,
    freshWaxFee: 0.02,
    totalFees: 0.15,
    netRevenue: CODE_ONE_NEW,
    artistPayout: CODE_ONE_NEW,
    artistPayoutStatus: 'pending',
    paymentMethod: 'paypal',
    paymentId: null,
    currency: 'GBP',
    itemCount: 0,
    hasPhysical: false,
    hasDigital: true,
    items: [], // split-recipient — primary owner is Bakkus, so Code One's items=[]
    backfilledAt: nowISO,
    backfillSource: 'retroactive-split',
    splitApplied: true,
    splitNote,
  });
  console.log('4. Code One salesLedger created.');

  // 5. Decrement Bakkus pendingBalance
  await commitIncrement(token, 'artists', BAKKUS_ID, 'pendingBalance', -(TOTAL_ARTIST_PAYOUT - BAKKUS_NEW));
  console.log(`5. Bakkus pendingBalance: -£${(TOTAL_ARTIST_PAYOUT - BAKKUS_NEW).toFixed(4)}`);

  // 6. Increment Code One pendingBalance
  await commitIncrement(token, 'artists', CODE_ONE_ID, 'pendingBalance', CODE_ONE_NEW);
  console.log(`6. Code One pendingBalance: +£${CODE_ONE_NEW.toFixed(4)}`);

  // Verify
  console.log('\nVerifying balances:');
  const bakkus = await getDoc(token, 'artists', BAKKUS_ID);
  const codeone = await getDoc(token, 'artists', CODE_ONE_ID);
  console.log(`  Bakkus pendingBalance:  £${Number(bakkus.pendingBalance).toFixed(4)}`);
  console.log(`  Code One pendingBalance: £${Number(codeone.pendingBalance).toFixed(4)}`);
})().catch(e => { console.error(e); process.exit(1); });
