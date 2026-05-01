// Backfill salesLedger entries for PayPal orders that are missing them.
// Uses pendingPayouts as source of truth for per-artist amounts (handles
// payoutSplits correctly — the existing /api/admin/backfill-ledger endpoint
// re-derives from release.submitterId which misses splits).
//
// Idempotent: writes deterministic doc IDs (`ledger_<orderId>_<artistIdSlice>`)
// and skips orders that already have any salesLedger entry. Pass --dry to preview.
//
// Usage:
//   node scripts/backfill-paypal-ledger.cjs           (dry run)
//   node scripts/backfill-paypal-ledger.cjs --apply   (write)
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

async function listCol(token, col, limit) {
  limit = limit || 500;
  const FB = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents:runQuery';
  const r = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], limit } }) });
  return (await r.json()).filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
}

async function setDoc(token, col, id, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}/${id}`;
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFsValue(v);
  const r = await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`setDoc ${col}/${id} failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function getArtist(token, artistId, cache) {
  if (cache.has(artistId)) return cache.get(artistId);
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${artistId}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { cache.set(artistId, null); return null; }
  const j = await r.json();
  const doc = Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
  cache.set(artistId, doc);
  return doc;
}

(async () => {
  console.log(`[backfill-paypal-ledger] mode = ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);
  const token = await getToken();
  const [orders, ledger, pendingPayouts] = await Promise.all([
    listCol(token, 'orders', 200),
    listCol(token, 'salesLedger', 500),
    listCol(token, 'pendingPayouts', 500),
  ]);

  const ordersWithLedger = new Set();
  for (const e of ledger) if (e.orderId) ordersWithLedger.add(e.orderId);

  // Group pending payouts by orderId
  const payoutsByOrder = new Map();
  for (const p of pendingPayouts) {
    if (!p.orderId) continue;
    if (!payoutsByOrder.has(p.orderId)) payoutsByOrder.set(p.orderId, []);
    payoutsByOrder.get(p.orderId).push(p);
  }

  // Find PayPal orders missing ledger entries
  const candidates = orders.filter(o =>
    o.paymentMethod === 'paypal' &&
    !ordersWithLedger.has(o.id) &&
    (o.paymentStatus === 'completed' || o.orderStatus === 'completed' || o.status === 'completed' || o.status === 'paid')
  );

  console.log(`Found ${candidates.length} completed PayPal orders missing ledger entries:`);
  for (const o of candidates) console.log(`  ${o.orderNumber || o.id} | £${(o.totals && o.totals.total) || 0} | ${o.createdAt}`);
  console.log('');

  const artistCache = new Map();
  let totalCreated = 0;
  const writeLog = [];

  for (const order of candidates) {
    const orderId = order.id;
    const orderNumber = order.orderNumber || '';
    const subtotal = (order.totals && order.totals.subtotal) || (order.totals && order.totals.total) || 0;
    const grossTotal = (order.totals && order.totals.total) || subtotal;
    const orderFreshWaxFee = (order.totals && order.totals.freshWaxFee) || (subtotal * 0.01);
    const orderPayPalFee = (subtotal * 0.029) + 0.30;
    const items = order.items || [];

    const payouts = payoutsByOrder.get(orderId) || [];

    if (payouts.length === 0) {
      console.log(`[skip] ${orderNumber || orderId} — no pendingPayouts rows; skipping (probably self-pay or already-paid manual)`);
      continue;
    }

    const totalPayout = payouts.reduce((s, p) => s + Number(p.amount || 0), 0);
    if (totalPayout === 0) {
      console.log(`[skip] ${orderNumber || orderId} — total payout is 0`);
      continue;
    }

    console.log(`[process] ${orderNumber || orderId} | subtotal=£${subtotal.toFixed(2)} fees=FW£${orderFreshWaxFee.toFixed(2)} PP£${orderPayPalFee.toFixed(2)} | ${payouts.length} payees`);

    const now = order.createdAt ? new Date(order.createdAt) : new Date();

    for (const payout of payouts) {
      const artistId = payout.sellerId || payout.artistId;
      if (!artistId) { console.log('  - missing artistId on payout row, skipping'); continue; }
      const artistPayout = Number(payout.amount || 0);
      if (artistPayout <= 0) { console.log(`  - ${artistId}: £0 payout, skipping`); continue; }

      const artistDoc = await getArtist(token, artistId, artistCache);
      const artistName = (artistDoc && (artistDoc.artistName || artistDoc.displayName || artistDoc.name)) || null;
      const submitterEmail = (artistDoc && artistDoc.email) || null;

      // This artist's proportional share of the order
      const proportion = artistPayout / totalPayout;
      const artistGross = Math.round(((subtotal * proportion)) * 100) / 100;
      const artistFwFee = Math.round((orderFreshWaxFee * proportion) * 100) / 100;
      const artistPpFee = Math.round((orderPayPalFee * proportion) * 100) / 100;
      const totalFees = Math.round((artistFwFee + artistPpFee) * 100) / 100;

      // Match production status: pendingPayouts.status === 'pending'/'paid'
      const status = payout.status === 'paid' ? 'paid' : 'pending';

      // Item summary — best effort, just for human readability in admin views
      const itemsSummary = items.map(it => ({
        type: it.type || 'release',
        id: it.releaseId || it.productId || it.id || '',
        title: it.title || it.name || 'Unknown',
        artist: it.artist || it.artistName || artistName || '',
        quantity: Number(it.quantity || 1),
        unitPrice: Number(it.price || 0),
        lineTotal: Number(it.price || 0) * Number(it.quantity || 1),
      }));

      const ledgerEntry = {
        orderId,
        orderNumber,
        timestamp: now.toISOString(),
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        customerId: (order.customer && order.customer.userId) || null,
        customerEmail: (order.customer && order.customer.email) || '',
        customerName: (order.customer && (order.customer.displayName || order.customer.firstName)) || null,
        artistId,
        artistName,
        submitterId: artistId,
        submitterEmail,
        subtotal: artistGross,
        shipping: 0,
        discount: 0,
        grossTotal: artistGross,
        stripeFee: 0,
        paypalFee: artistPpFee,
        freshWaxFee: artistFwFee,
        totalFees,
        netRevenue: artistPayout,
        artistPayout,
        artistPayoutStatus: status,
        paymentMethod: 'paypal',
        paymentId: order.paypalOrderId || null,
        currency: 'GBP',
        itemCount: itemsSummary.length,
        hasPhysical: false,
        hasDigital: true,
        items: itemsSummary,
        backfilledAt: new Date().toISOString(),
        backfillSource: 'pendingPayouts',
      };

      const ledgerId = `ledger_${orderId}_${String(artistId).slice(-6)}`;

      console.log(`  -> ${artistId} (${artistName || '?'}) | gross £${artistGross} | payout £${artistPayout} | status=${status} | id=${ledgerId}`);
      writeLog.push({ orderId, orderNumber, ledgerId, artistId, artistGross, artistPayout, status });

      if (APPLY) {
        try {
          await setDoc(token, 'salesLedger', ledgerId, ledgerEntry);
          totalCreated++;
        } catch (err) {
          console.error('     WRITE FAILED:', err.message);
        }
      }
    }
  }

  console.log('');
  console.log(`Summary: ${writeLog.length} ledger rows planned${APPLY ? `, ${totalCreated} written` : ' (dry run)'}`);
  if (!APPLY) console.log('Re-run with --apply to write.');
})().catch(e => { console.error(e); process.exit(1); });
