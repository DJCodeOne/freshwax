// Configure split-payout for a release. Writes a payoutSplits array to
// releases/<id> and (optionally) re-balances any existing pendingPayouts
// rows for that release on a specific order.
//
// Usage:
//   node scripts/set-payout-splits.cjs <releaseId> <splits> [--rebalance-order <orderId>]
// Where <splits> is comma-separated `<uid>:<pct>` pairs, e.g.
//   8WmxYeCp4PSym5iWHahgizokn5F2:50,CCMDrCWRkUXiPN7O83iSfm1BxGo1:50
//
// Percentages must sum to 100.
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

const args = process.argv.slice(2);
const releaseId = args[0];
const splitsArg = args[1];
const rebalIdx = args.indexOf('--rebalance-order');
const rebalanceOrderId = rebalIdx >= 0 ? args[rebalIdx + 1] : null;
if (!releaseId || !splitsArg) {
  console.error('usage: node scripts/set-payout-splits.cjs <releaseId> <uid1>:<pct1>,<uid2>:<pct2>... [--rebalance-order <orderId>]');
  process.exit(1);
}
const splits = splitsArg.split(',').map((s) => {
  const [artistId, pct] = s.split(':');
  return { artistId: artistId.trim(), percentage: parseFloat(pct) };
});
const total = splits.reduce((sum, s) => sum + s.percentage, 0);
if (Math.abs(total - 100) > 0.01) {
  console.error(`Splits sum to ${total}, must be 100`);
  process.exit(1);
}

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
  if (v.nullValue !== undefined) return null;
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

(async () => {
  const token = await getToken();

  // 1. Verify each artistId exists
  for (const s of splits) {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${s.artistId}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`Artist ${s.artistId} not found in artists/`);
      process.exit(1);
    }
    const f = (await res.json()).fields || {};
    console.log(`  ${s.percentage}% -> ${parseVal(f.artistName) || parseVal(f.displayName)} (${parseVal(f.email)}) [${s.artistId}]`);
  }

  // 2. Patch the release doc
  console.log(`\nWriting payoutSplits to releases/${releaseId}...`);
  const patchUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${releaseId}?updateMask.fieldPaths=payoutSplits&updateMask.fieldPaths=updatedAt`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        payoutSplits: toFsValue(splits),
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    console.error('Release patch failed:', patchRes.status, err);
    process.exit(1);
  }
  console.log('  Release updated.');

  // 3. Optionally re-balance pendingPayouts for an order
  if (rebalanceOrderId) {
    console.log(`\nRe-balancing existing pendingPayouts for order ${rebalanceOrderId}...`);
    // Find pendingPayouts for this order
    const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
    const q = {
      structuredQuery: {
        from: [{ collectionId: 'pendingPayouts' }],
        where: { fieldFilter: { field: { fieldPath: 'orderId' }, op: 'EQUAL', value: { stringValue: rebalanceOrderId } } },
        limit: 50,
      },
    };
    const r = await fetch(FB, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    const arr = await r.json();
    if (!Array.isArray(arr)) { console.log('  No matching payouts.'); return; }

    // Pull the order to figure out items per release for accurate split
    const ordRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/orders/${rebalanceOrderId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!ordRes.ok) { console.error('Order not found'); process.exit(1); }
    const ordFields = (await ordRes.json()).fields || {};
    const orderItems = parseVal(ordFields.items) || [];
    const orderSubtotal = parseVal(ordFields.subtotal) || orderItems.reduce((s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0);
    const totalItemCount = orderItems.length;

    // For each item that's on the target release, recompute artistShare
    // and find its corresponding existing pendingPayout to delete + replace.
    const releaseItems = orderItems.filter((i) => (i.releaseId || i.productId || i.id) === releaseId);
    if (releaseItems.length === 0) { console.log('  No items in this order match the release.'); return; }

    const totalArtistShareForRelease = releaseItems.reduce((sum, item) => {
      const itemTotal = (item.price || 0) * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      const totalProcFee = (orderSubtotal * 0.014) + 0.20;
      const procFeePerSeller = totalProcFee / totalItemCount;
      return sum + (itemTotal - freshWaxFee - procFeePerSeller);
    }, 0);
    console.log(`  Total artist share for release on this order: £${totalArtistShareForRelease.toFixed(4)}`);

    // Find existing payout doc(s) — usually 1 row with the wholesale artistShare.
    // Strategy: delete all matching rows whose amount == totalArtistShareForRelease (within rounding),
    // then re-create per the new splits.
    const existing = arr.filter((row) => row.document).map((row) => {
      const f = row.document.fields || {};
      return { id: row.document.name.split('/').pop(), artistId: parseVal(f.artistId), amount: parseVal(f.amount), status: parseVal(f.status), name: row.document.name };
    });
    console.log(`  Found ${existing.length} pendingPayout row(s):`);
    for (const e of existing) console.log(`    [${e.id}] ${e.artistId} £${e.amount} (${e.status})`);

    // Find the wholesale row (matching the total computed amount)
    const wholesale = existing.find((e) => Math.abs(e.amount - totalArtistShareForRelease) < 0.01 && e.status === 'pending');
    if (!wholesale) {
      console.log('  No wholesale row matched the expected total — leaving alone, doing nothing.');
      return;
    }

    // Decrement old artist's pendingBalance + delete the row.
    // GET must NOT carry `updateMask` query params — that's a PATCH-only
    // attribute and Firestore returns 400 when it's used on a read,
    // making `inc.ok === false` and silently skipping the decrement.
    // Plain GET is what we want here.
    console.log(`  Reversing wholesale row £${wholesale.amount} from ${wholesale.artistId}`);
    const inc = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${wholesale.artistId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!inc.ok) {
      console.error(`    ⚠ GET old artist failed: ${inc.status} ${await inc.text()} — aborting rebalance to keep ledger consistent.`);
      return;
    }
    const f = (await inc.json()).fields || {};
    const cur = parseVal(f.pendingBalance) || 0;
    const newBal = Math.max(0, cur - wholesale.amount);
    const decRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${wholesale.artistId}?updateMask.fieldPaths=pendingBalance&updateMask.fieldPaths=updatedAt`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { pendingBalance: toFsValue(newBal), updatedAt: { timestampValue: new Date().toISOString() } } }),
    });
    if (!decRes.ok) {
      console.error(`    ⚠ PATCH decrement failed: ${decRes.status} ${await decRes.text()} — aborting before deleting payout row.`);
      return;
    }
    console.log(`    Old artist pendingBalance: £${cur.toFixed(4)} -> £${newBal.toFixed(4)}`);

    const delRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/pendingPayouts/${wholesale.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    console.log(`    Deleted old payout row: ${delRes.ok ? 'ok' : 'fail'}`);

    // Create new split rows
    const orderNumber = parseVal(ordFields.orderNumber);
    for (const s of splits) {
      const share = totalArtistShareForRelease * (s.percentage / 100);
      const aRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${s.artistId}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const aFields = (await aRes.json()).fields || {};
      const artistName = parseVal(aFields.artistName) || parseVal(aFields.displayName) || 'Unknown Artist';
      const artistEmail = parseVal(aFields.email) || '';
      const curBal = parseVal(aFields.pendingBalance) || 0;

      const createRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/pendingPayouts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            artistId: { stringValue: s.artistId },
            artistName: { stringValue: artistName },
            artistEmail: { stringValue: artistEmail },
            orderId: { stringValue: rebalanceOrderId },
            orderNumber: { stringValue: orderNumber || '' },
            amount: toFsValue(share),
            currency: { stringValue: 'gbp' },
            status: { stringValue: 'pending' },
            customerPaymentMethod: { stringValue: 'admin-rebalance' },
            createdAt: { timestampValue: new Date().toISOString() },
            updatedAt: { timestampValue: new Date().toISOString() },
            note: { stringValue: `Re-balanced from wholesale payout (was 100% to ${wholesale.artistId})` },
          },
        }),
      });
      console.log(`  Created payout: ${s.percentage}% -> £${share.toFixed(4)} to ${artistName} (${createRes.ok ? 'ok' : 'fail'})`);

      // Bump new artist's pendingBalance
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${s.artistId}?updateMask.fieldPaths=pendingBalance&updateMask.fieldPaths=updatedAt`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { pendingBalance: toFsValue(curBal + share), updatedAt: { timestampValue: new Date().toISOString() } } }),
      });
      console.log(`    ${artistName} pendingBalance: £${curBal.toFixed(4)} -> £${(curBal + share).toFixed(4)}`);
    }
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
