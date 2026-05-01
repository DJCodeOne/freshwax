// Cross-reference pendingPayouts (Firestore) and royalty_ledger (D1) for an
// order, showing per-payee totals and any missing/extra entries that would
// cause a dashboard discrepancy.
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
const ORDER_ID = process.argv[2];
if (!ORDER_ID) { console.error('usage: node scripts/audit-order-payouts.cjs <orderId>'); process.exit(1); }

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function parseVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
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
(async () => {
  const token = await getToken();
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

  // 1. Read order items + per-release expected payees
  const ordRes = await fetch(`${FB}/orders/${ORDER_ID}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!ordRes.ok) { console.error('Order not found'); process.exit(1); }
  const ordFields = (await ordRes.json()).fields || {};
  const orderNumber = parseVal(ordFields.orderNumber);
  const items = parseVal(ordFields.items) || [];
  const orderSubtotal = parseVal(ordFields.subtotal) || items.reduce((s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0);
  const totalItemCount = items.length;
  const paymentMethod = parseVal(ordFields.paymentMethod);
  // Mirror src/lib/order/seller-payments/types.ts:getProcessingFee
  const procRate = paymentMethod === 'paypal' ? 0.029 : 0.014;
  const procFixed = paymentMethod === 'paypal' ? 0.30 : 0.20;
  console.log(`Order: ${ORDER_ID} (${orderNumber})`);
  console.log(`Items: ${totalItemCount}, Subtotal: £${orderSubtotal.toFixed(2)}, paymentMethod: ${paymentMethod}\n`);

  // Resolve releases for digital items
  const digital = items.filter((i) => ['track', 'digital', 'release'].includes(i.type));
  const releaseIds = new Set(digital.map((i) => i.releaseId || i.productId || i.id).filter(Boolean));
  const releaseEntries = await Promise.all([...releaseIds].map(async (id) => {
    const r = await fetch(`${FB}/releases/${id}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return [id, null];
    const f = (await r.json()).fields || {};
    return [id, { releaseName: parseVal(f.releaseName) || parseVal(f.title), artistId: parseVal(f.artistId), userId: parseVal(f.userId), payoutSplits: parseVal(f.payoutSplits) }];
  }));
  const releaseMap = new Map(releaseEntries.filter(([, d]) => d));

  // Build expected per-payee shares
  const expected = new Map(); // payeeId -> { share, items }
  for (const item of digital) {
    const releaseId = item.releaseId || item.productId || item.id;
    const release = releaseMap.get(releaseId);
    if (!release) continue;
    const itemTotal = (item.price || 0) * (item.quantity || 1);
    const freshWaxFee = itemTotal * 0.01;
    const procFee = ((orderSubtotal * procRate) + procFixed) / totalItemCount;
    const artistShare = itemTotal - freshWaxFee - procFee;
    const splits = Array.isArray(release.payoutSplits) && release.payoutSplits.length
      ? release.payoutSplits.filter((s) => s && s.artistId && s.percentage > 0)
      : [{ artistId: item.artistId || release.artistId || release.userId, percentage: 100 }];
    for (const s of splits) {
      const aid = s.artistId; if (!aid) continue;
      const slice = artistShare * (s.percentage / 100);
      const cur = expected.get(aid) || { share: 0, items: [] };
      cur.share += slice;
      cur.items.push(`${item.name} (${s.percentage}% £${slice.toFixed(4)})`);
      expected.set(aid, cur);
    }
  }

  // 2. Read pendingPayouts for this order
  const ppQ = {
    structuredQuery: {
      from: [{ collectionId: 'pendingPayouts' }],
      where: { fieldFilter: { field: { fieldPath: 'orderId' }, op: 'EQUAL', value: { stringValue: ORDER_ID } } },
      limit: 50,
    },
  };
  const ppRes = await fetch(`${FB}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(ppQ) });
  const ppArr = await ppRes.json();
  const pendingByPayee = new Map();
  for (const row of (Array.isArray(ppArr) ? ppArr : [])) {
    if (!row.document) continue;
    const f = row.document.fields || {};
    const aid = parseVal(f.artistId);
    const amount = parseVal(f.amount);
    const status = parseVal(f.status);
    const cur = pendingByPayee.get(aid) || { rows: [], total: 0 };
    cur.rows.push({ id: row.document.name.split('/').pop(), amount, status });
    cur.total += amount;
    pendingByPayee.set(aid, cur);
  }

  // 3. Print comparison
  console.log('=== Per-payee expected vs actual (pendingPayouts) ===\n');
  const allPayeeIds = new Set([...expected.keys(), ...pendingByPayee.keys()]);
  for (const aid of allPayeeIds) {
    // Resolve payee name
    const aRes = await fetch(`${FB}/artists/${aid}`, { headers: { Authorization: 'Bearer ' + token } });
    const aFields = aRes.ok ? (await aRes.json()).fields || {} : {};
    const name = parseVal(aFields.artistName) || parseVal(aFields.displayName) || aid;
    const balance = parseVal(aFields.pendingBalance) || 0;

    const exp = expected.get(aid);
    const got = pendingByPayee.get(aid);

    console.log(`${name} [${aid}]`);
    console.log(`  current pendingBalance: £${balance.toFixed(4)}`);
    if (exp) console.log(`  expected from this order: £${exp.share.toFixed(4)} across ${exp.items.length} item(s)`);
    if (got) {
      console.log(`  pendingPayouts rows for this order: ${got.rows.length} (total £${got.total.toFixed(4)})`);
      for (const r of got.rows) console.log(`    - ${r.id}: £${r.amount.toFixed(4)} (${r.status})`);
    } else {
      console.log(`  pendingPayouts rows for this order: NONE`);
    }
    if (exp && got) {
      const delta = exp.share - got.total;
      console.log(`  delta (expected - actual): £${delta.toFixed(4)} ${Math.abs(delta) < 0.01 ? '✓' : '⚠'}`);
    } else if (exp && !got) {
      console.log(`  ⚠ MISSING pendingPayouts row for £${exp.share.toFixed(4)}`);
    } else if (!exp && got) {
      console.log(`  ⚠ Has pendingPayouts but not expected (legacy/wholesale row?)`);
    }
    console.log('');
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
