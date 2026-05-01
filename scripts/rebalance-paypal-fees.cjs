// One-shot fix: recompute pendingPayouts amounts for PayPal orders that
// were calculated using the Stripe fee formula (1.4% + £0.20) instead of
// the higher PayPal rate (2.9% + £0.30). Adjust each payout row + the
// payee's pendingBalance by the per-payee delta.
//
// Usage:
//   node scripts/rebalance-paypal-fees.cjs <orderId>            (single order)
//   node scripts/rebalance-paypal-fees.cjs --uid <userId>       (all PayPal orders for a buyer)
//   --dry-run to preview without writing.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
for (const raw of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('='); if (eq < 0) continue;
  const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uidIdx = args.indexOf('--uid');
let orderId = null, uid = null;
if (uidIdx >= 0) uid = args[uidIdx + 1];
else orderId = args.find((a) => !a.startsWith('--')) || null;
if (!orderId && !uid) {
  console.error('usage: node scripts/rebalance-paypal-fees.cjs <orderId> | --uid <uid> [--dry-run]');
  process.exit(1);
}

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
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  return (await tr.json()).access_token;
}

async function processOrder(token, orderId) {
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const ordRes = await fetch(`${FB}/orders/${orderId}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!ordRes.ok) { console.log(`[skip] order ${orderId}: not found`); return; }
  const ordFields = (await ordRes.json()).fields || {};
  const paymentMethod = parseVal(ordFields.paymentMethod);
  if (paymentMethod !== 'paypal') { console.log(`[skip] order ${orderId}: paymentMethod=${paymentMethod}`); return; }

  const items = parseVal(ordFields.items) || [];
  const orderSubtotal = parseVal(ordFields.subtotal) || items.reduce((s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0);
  const totalItemCount = items.length;

  // Stripe-rate fee that was used to calculate existing payouts
  const stripeFeeOld = (orderSubtotal * 0.014) + 0.20;
  // PayPal-rate fee that should have been used
  const paypalFeeNew = (orderSubtotal * 0.029) + 0.30;
  const feeDelta = paypalFeeNew - stripeFeeOld;
  const deltaPerItem = feeDelta / totalItemCount;
  console.log(`\n=== ${orderId} ===`);
  console.log(`  subtotal £${orderSubtotal.toFixed(2)}, items ${totalItemCount}`);
  console.log(`  Stripe-rate fee (used): £${stripeFeeOld.toFixed(4)}`);
  console.log(`  PayPal-rate fee (correct): £${paypalFeeNew.toFixed(4)}`);
  console.log(`  Total delta to deduct: £${feeDelta.toFixed(4)} (per-item £${deltaPerItem.toFixed(4)})`);

  // Find the pendingPayouts for this order (only digital ones, since we're touching artist-payments)
  const q = {
    structuredQuery: {
      from: [{ collectionId: 'pendingPayouts' }],
      where: { fieldFilter: { field: { fieldPath: 'orderId' }, op: 'EQUAL', value: { stringValue: orderId } } },
      limit: 50,
    },
  };
  const r = await fetch(`${FB}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const arr = await r.json();
  const rows = (Array.isArray(arr) ? arr : []).filter((row) => row.document).map((row) => ({
    id: row.document.name.split('/').pop(),
    artistId: parseVal(row.document.fields?.artistId),
    amount: parseVal(row.document.fields?.amount),
    status: parseVal(row.document.fields?.status),
    feeRebalanced: parseVal(row.document.fields?.feeRebalanced),
  }));
  if (rows.length === 0) { console.log('  no pendingPayouts rows'); return; }

  // For each release in the order, count its items to compute that release's
  // share of the per-item delta. Then for each pendingPayout row tied to a
  // release/payee, deduct delta * (its share of items).
  const itemsByRelease = new Map();
  for (const item of items) {
    const releaseId = item.releaseId || item.productId || item.id;
    if (!releaseId) continue;
    const list = itemsByRelease.get(releaseId) || [];
    list.push(item);
    itemsByRelease.set(releaseId, list);
  }

  // Resolve each release's split or single artist
  const releaseEntries = await Promise.all([...itemsByRelease.keys()].map(async (rid) => {
    const r2 = await fetch(`${FB}/releases/${rid}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r2.ok) return [rid, null];
    const f = (await r2.json()).fields || {};
    return [rid, { artistId: parseVal(f.artistId), userId: parseVal(f.userId), payoutSplits: parseVal(f.payoutSplits) }];
  }));
  const releaseMap = new Map(releaseEntries.filter(([, d]) => d));

  // Build per-payee item count + pending row map
  const payeeItemCount = new Map(); // payeeId -> item count attributed
  for (const [releaseId, list] of itemsByRelease) {
    const release = releaseMap.get(releaseId);
    if (!release) continue;
    const splits = Array.isArray(release.payoutSplits) && release.payoutSplits.length
      ? release.payoutSplits.filter((s) => s && s.artistId && s.percentage > 0)
      : [{ artistId: release.artistId || release.userId, percentage: 100 }];
    for (const item of list) {
      for (const s of splits) {
        const aid = s.artistId; if (!aid) continue;
        // Each split recipient's share of this item
        const fractionOfItem = s.percentage / 100;
        payeeItemCount.set(aid, (payeeItemCount.get(aid) || 0) + fractionOfItem);
      }
    }
  }

  console.log('  Payee deltas:');
  for (const [aid, itemFrac] of payeeItemCount) {
    const deduction = deltaPerItem * itemFrac;
    const row = rows.find((rr) => rr.artistId === aid && rr.status === 'pending' && !rr.feeRebalanced);
    console.log(`    ${aid}: items=${itemFrac.toFixed(2)}, deduct £${deduction.toFixed(4)}, row=${row ? row.id : 'NONE'}`);
    if (!row) continue;
    if (dryRun) continue;

    // Update payout row amount
    const newAmount = +(row.amount - deduction).toFixed(4);
    const patchRowRes = await fetch(`${FB}/pendingPayouts/${row.id}?updateMask.fieldPaths=amount&updateMask.fieldPaths=feeRebalanced&updateMask.fieldPaths=updatedAt`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { amount: toFsValue(newAmount), feeRebalanced: { booleanValue: true }, updatedAt: { timestampValue: new Date().toISOString() } } }),
    });
    if (!patchRowRes.ok) { console.error(`      [fail] payout patch: ${await patchRowRes.text()}`); continue; }

    // Decrement artist's pendingBalance by the same deduction
    const aRes = await fetch(`${FB}/artists/${aid}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!aRes.ok) { console.error(`      [fail] artist read`); continue; }
    const aFields = (await aRes.json()).fields || {};
    const curBal = parseVal(aFields.pendingBalance) || 0;
    const newBal = Math.max(0, +(curBal - deduction).toFixed(4));
    const patchArtistRes = await fetch(`${FB}/artists/${aid}?updateMask.fieldPaths=pendingBalance&updateMask.fieldPaths=updatedAt`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { pendingBalance: toFsValue(newBal), updatedAt: { timestampValue: new Date().toISOString() } } }),
    });
    if (!patchArtistRes.ok) { console.error(`      [fail] artist patch`); continue; }
    console.log(`      ✓ row £${row.amount.toFixed(4)} → £${newAmount.toFixed(4)}; artist balance £${curBal.toFixed(4)} → £${newBal.toFixed(4)}`);
  }
}

(async () => {
  const token = await getToken();
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const targets = [];
  if (orderId) targets.push(orderId);
  if (uid) {
    const q = {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        where: { fieldFilter: { field: { fieldPath: 'customer.userId' }, op: 'EQUAL', value: { stringValue: uid } } },
        orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
        limit: 50,
      },
    };
    const r = await fetch(`${FB}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    const arr = await r.json();
    for (const row of arr) if (row.document) targets.push(row.document.name.split('/').pop());
    console.log(`Found ${targets.length} order(s) for uid=${uid}`);
  }
  for (const id of targets) await processOrder(token, id);
  console.log('\nDone.' + (dryRun ? ' (dry-run, no writes)' : ''));
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
