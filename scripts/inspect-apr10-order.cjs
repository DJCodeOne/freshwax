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
function objFrom(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, parseVal(v)]));
}

(async () => {
  const token = await getToken();
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

  // Find order by orderNumber
  const r = await fetch(FB + ':runQuery', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({
    structuredQuery: { from: [{ collectionId: 'orders' }], where: { fieldFilter: { field: { fieldPath: 'orderNumber' }, op: 'EQUAL', value: { stringValue: 'FW-260410-EL5XI2' } } }, limit: 1 }
  }) });
  const arr = await r.json();
  const docNode = arr.find(x => x.document);
  if (!docNode) { console.log('order not found'); return; }
  const orderId = docNode.document.name.split('/').pop();
  const order = objFrom(docNode.document.fields);
  console.log('=== ORDER', orderId, '===');
  console.log('  orderNumber:', order.orderNumber);
  console.log('  paymentMethod:', order.paymentMethod);
  console.log('  totals:', JSON.stringify(order.totals));
  console.log('  customer email:', order.customer && order.customer.email);
  console.log('  items:');
  for (const it of order.items || []) {
    console.log('    -', it.title || it.name, '| releaseId=' + (it.releaseId || it.id) + ' | price=' + it.price + ' qty=' + (it.quantity || 1));
  }

  // pendingPayouts for this order
  const r2 = await fetch(FB + ':runQuery', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({
    structuredQuery: { from: [{ collectionId: 'pendingPayouts' }], where: { fieldFilter: { field: { fieldPath: 'orderId' }, op: 'EQUAL', value: { stringValue: orderId } } }, limit: 5 }
  }) });
  const pp = (await r2.json()).filter(x => x.document);
  console.log('\n=== PENDING PAYOUTS (' + pp.length + ') ===');
  for (const x of pp) {
    const id = x.document.name.split('/').pop();
    const f = objFrom(x.document.fields);
    console.log('  ' + id, '| seller=' + (f.sellerId || f.artistId) + ' (' + f.artistName + ')', '| £' + f.amount, '| status=' + f.status, '| feeRebalanced=' + (f.feeRebalanced || false));
  }

  // salesLedger for this order
  const r3 = await fetch(FB + ':runQuery', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({
    structuredQuery: { from: [{ collectionId: 'salesLedger' }], where: { fieldFilter: { field: { fieldPath: 'orderId' }, op: 'EQUAL', value: { stringValue: orderId } } }, limit: 5 }
  }) });
  const sl = (await r3.json()).filter(x => x.document);
  console.log('\n=== SALES LEDGER (' + sl.length + ') ===');
  for (const x of sl) {
    const id = x.document.name.split('/').pop();
    const f = objFrom(x.document.fields);
    console.log('  ' + id, '| submitter=' + f.submitterId + ' (' + f.artistName + ')', '| gross £' + f.grossTotal, '| artist £' + f.artistPayout, '| status=' + f.artistPayoutStatus);
  }

  // Lookup release to confirm payoutSplits
  const items = order.items || [];
  const releaseId = items.length ? (items[0].releaseId || items[0].id) : null;
  if (releaseId) {
    const r4 = await fetch(`${FB}/releases/${releaseId}`, { headers: { Authorization: 'Bearer ' + token } });
    if (r4.ok) {
      const f = objFrom((await r4.json()).fields);
      console.log('\n=== RELEASE', releaseId, '===');
      console.log('  title:', f.title);
      console.log('  artistId:', f.artistId);
      console.log('  payoutSplits:', JSON.stringify(f.payoutSplits));
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
