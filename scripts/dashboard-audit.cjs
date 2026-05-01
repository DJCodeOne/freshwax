// Audit what the admin dashboard reads to figure out why values are wrong
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
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  return (await tr.json()).access_token;
}
async function listCol(token, col, limit) {
  limit = limit || 200;
  const FB = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents:runQuery';
  const r = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], limit } }) });
  return (await r.json()).filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
}

(async () => {
  const token = await getToken();
  const [orders, ledger, pendingPayouts, artists] = await Promise.all([
    listCol(token, 'orders', 100),
    listCol(token, 'salesLedger', 500),
    listCol(token, 'pendingPayouts', 500),
    listCol(token, 'artists', 100),
  ]);

  console.log('=== ORDERS (' + orders.length + ' total) ===');
  const sorted = orders.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  for (const o of sorted.slice(0, 10)) {
    const tot = (o.totals && o.totals.total) != null ? o.totals.total : (o.total != null ? o.total : 0);
    const sub = (o.totals && o.totals.subtotal) != null ? o.totals.subtotal : 0;
    console.log('  ' + (o.orderNumber || o.id) + ' | ' + o.createdAt + ' | ' + (o.paymentMethod || '?') + ' | total £' + Number(tot).toFixed(2) + ' sub £' + Number(sub).toFixed(2) + ' | status=' + (o.paymentStatus || o.orderStatus || o.status || '?'));
  }

  console.log('\n=== SALES LEDGER (' + ledger.length + ' entries) ===');
  let lgGross = 0, lgArt = 0, lgPending = 0, lgPaid = 0, lgPendingCount = 0;
  for (const e of ledger) {
    lgGross += Number(e.grossTotal || 0);
    lgArt += Number(e.artistPayout || 0);
    if (e.artistPayoutStatus === 'pending' || e.artistPayoutStatus === 'unpaid') {
      lgPending += Number(e.artistPayout || 0);
      lgPendingCount++;
    }
    if (e.artistPayoutStatus === 'paid') lgPaid += Number(e.artistPayout || 0);
  }
  console.log('  total gross: £' + lgGross.toFixed(2) + ' | total artistPayout: £' + lgArt.toFixed(2));
  console.log('  pending: £' + lgPending.toFixed(2) + ' (' + lgPendingCount + ' entries) | paid: £' + lgPaid.toFixed(2));
  console.log('  recent ledger entries:');
  for (const e of ledger.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 10)) {
    console.log('    ' + e.id + ' | ' + e.createdAt + ' | gross £' + Number(e.grossTotal || 0).toFixed(2) + ' | artist £' + Number(e.artistPayout || 0).toFixed(2) + ' | status=' + e.artistPayoutStatus + ' | order=' + (e.orderId || e.orderNumber || '?') + ' | paymentMethod=' + (e.paymentMethod || '?'));
  }

  console.log('\n=== PENDING PAYOUTS (' + pendingPayouts.length + ' entries) ===');
  let ppTotal = 0;
  for (const p of pendingPayouts) ppTotal += Number(p.amount || 0);
  console.log('  total amount across all rows: £' + ppTotal.toFixed(2));
  for (const p of pendingPayouts.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 10)) {
    console.log('    ' + p.id + ' | ' + p.createdAt + ' | £' + Number(p.amount || 0).toFixed(2) + ' | seller=' + (p.sellerId || p.artistId || '?') + ' | order=' + (p.orderId || p.orderNumber || '?') + ' | status=' + (p.status || '?'));
  }

  console.log('\n=== ARTIST pendingBalance (sum across artists collection) ===');
  let aTot = 0;
  for (const a of artists) aTot += Number(a.pendingBalance || 0);
  console.log('  sum of all artists.pendingBalance: £' + aTot.toFixed(2));
  for (const a of artists.filter(x => Number(x.pendingBalance || 0) > 0).sort((a, b) => Number(b.pendingBalance || 0) - Number(a.pendingBalance || 0))) {
    console.log('    ' + a.id + ' | ' + (a.artistName || a.name || a.displayName) + ' | pending £' + Number(a.pendingBalance || 0).toFixed(4));
  }
})().catch(e => { console.error(e); process.exit(1); });
