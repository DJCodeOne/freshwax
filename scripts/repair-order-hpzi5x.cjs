// Repair order FW-260611-HPZI5X (orders/udSgfneZT3RUUrycCjif)
// The order was created by the verify-session fallback with a junk
// 'stripe_item_0' digital item and no shipping address. This script restores
// what the webhook path would have written, using the surviving
// pendingCheckouts/i06Vrlh55kdBr62s2uCQ data:
//   1. Order doc: correct vinyl item (+part-1 downloads), shipping, totals
//   2. Release: vinylParts[0] stock 200->199, sold 0->1
//   3. vinyl-stock-movements audit doc
//   4. salesLedger entry (Firebase) + prints D1 SQL for sales_ledger
//   5. pendingPayouts doc for Hangry + artists.pendingBalance increment
// Usage: node scripts/repair-order-hpzi5x.cjs          (dry run)
//        node scripts/repair-order-hpzi5x.cjs --apply
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
const ORDER_NUM = 'FW-260611-HPZI5X';
const RELEASE_ID = 'hangry_records_FW-1780739181417';
const ARTIST_ID = 'dW3n7mwOiqgDnODGvPs7fXbgIbo1';
const PAYMENT_INTENT = 'pi_3ThILTIDZxi2HzfN1S6UFHeg';
const ORDER_TS = '2026-06-11T23:49:32.091Z';

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('token: ' + JSON.stringify(j));
  return j.access_token;
}
function pv(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = pv(x); return o; }
  if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
  return v;
}
function toFv(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toFv) } };
  if (typeof x === 'object') { const fields = {}; for (const [k, v] of Object.entries(x)) fields[k] = toFv(v); return { mapValue: { fields } }; }
  throw new Error('unsupported value: ' + typeof x);
}
async function getDoc(tok, p) {
  const r = await fetch(`${BASE}/${p}`, { headers: { Authorization: `Bearer ${tok}` } });
  const d = await r.json();
  if (d.error) throw new Error(`get ${p}: ${d.error.message}`);
  const f = {};
  for (const [k, v] of Object.entries(d.fields || {})) f[k] = pv(v);
  return f;
}
async function patchDoc(tok, p, obj) {
  const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFv(v);
  const r = await fetch(`${BASE}/${p}?${mask}`, { method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  const d = await r.json();
  if (d.error) throw new Error(`patch ${p}: ${d.error.message}`);
  return d;
}
async function addDoc(tok, collection, obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFv(v);
  const r = await fetch(`${BASE}/${collection}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  const d = await r.json();
  if (d.error) throw new Error(`add ${collection}: ${d.error.message}`);
  return d.name.split('/').pop();
}
async function incrementField(tok, docPath, field, by) {
  const r = await fetch(`${BASE.replace('/documents', '')}/documents:commit`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{ transform: { document: `projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`, fieldTransforms: [{ fieldPath: field, increment: { doubleValue: by } }] } }] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`increment ${docPath}.${field}: ${d.error.message}`);
}
function sqlEsc(s) { return String(s).replace(/'/g, "''"); }

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  const tok = await getToken();

  // --- Gather source data ---
  const release = await getDoc(tok, `releases/${RELEASE_ID}`);
  const parts = release.vinylParts || [];
  const part1 = parts[0];
  if (!part1 || part1.name !== 'Part 1') throw new Error('vinylParts[0] is not Part 1');
  const submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
  const submitterEmail = release.email || release.submitterEmail || null;
  console.log('Release seller info: submitterId=', submitterId, 'submitterEmail=', submitterEmail, 'artistId=', release.artistId);
  console.log('Part 1: stock=', part1.stock, 'sold=', part1.sold, 'trackNumbers=', JSON.stringify(part1.trackNumbers));

  // Part-1 download tracks (same filter as processItemsWithDownloads)
  const nums = new Set((part1.trackNumbers || []).map(Number));
  const allTracks = release.tracks || [];
  const downloadTracks = allTracks.filter((t, idx) => nums.has(Number(t.displayTrackNumber ?? t.trackNumber ?? (idx + 1))));
  console.log('Part-1 download tracks:', downloadTracks.map(t => t.trackName || t.name).join(' | '));
  if (downloadTracks.length === 0) throw new Error('No part-1 tracks matched — aborting');

  const artworkUrl = release.coverArtUrl || null;
  const downloadArtworkUrl = release.originalArtworkUrl || artworkUrl;

  // --- 1. Corrected order item + shipping + totals ---
  const correctedItem = {
    id: RELEASE_ID,
    productId: RELEASE_ID,
    releaseId: RELEASE_ID,
    trackId: null,
    name: 'Various Artists - Jungle & DnB Volume.1 (Part 1)',
    type: 'vinyl',
    price: 15,
    quantity: 1,
    size: null,
    color: null,
    image: artworkUrl,
    artwork: artworkUrl,
    artist: 'Various Artists',
    artistId: ARTIST_ID,
    title: 'Jungle & DnB Volume.1 (Part 1)',
    brandAccountId: null,
    brandName: null,
    vinylPartId: 'part-1',
    vinylPartName: 'Part 1',
    downloads: {
      artistName: release.artistName || 'Various Artists',
      releaseName: release.releaseName || 'Jungle & DnB Volume.1',
      artworkUrl: downloadArtworkUrl,
      tracks: downloadTracks.map(t => ({ name: t.trackName || t.name || '', mp3Url: t.mp3Url || null, wavUrl: t.wavUrl || null })),
    },
  };
  const shipping = { address1: '38 Hilldene Avenue', address2: '', city: 'Romford', county: 'Essex', postcode: 'RM3 8YP', country: 'United Kingdom' };
  const totals = { subtotal: 15, shipping: 4.99, freshWaxFee: 0.15, stripeFee: 0.48, serviceFees: 0.62986, total: 19.99 };
  console.log('\n[1] Order patch:', JSON.stringify({ items: [`<corrected vinyl item, ${correctedItem.downloads.tracks.length} download tracks>`], shipping, totals }, null, 2));

  // --- 2/3. Stock decrement + movement ---
  const prevStock = Number(part1.stock) || 0;
  const newStock = Math.max(0, prevStock - 1);
  const nextParts = parts.map((p, i) => i === 0 ? { ...p, stock: newStock, sold: (Number(p.sold) || 0) + 1 } : p);
  console.log(`\n[2] Release part-1 stock: ${prevStock} -> ${newStock}, sold -> ${(Number(part1.sold) || 0) + 1}`);

  const movement = {
    releaseId: RELEASE_ID, releaseName: correctedItem.name, vinylPartId: 'part-1', vinylPartName: 'Part 1',
    type: 'sell', quantity: 1, stockDelta: -1, previousStock: prevStock, newStock,
    orderId: ORDER_DOC, orderNumber: ORDER_NUM,
    notes: `Order ${ORDER_NUM} (Part 1) — recorded retroactively (verify-session fallback bug repair)`,
    createdAt: ORDER_TS, createdBy: 'system',
  };

  // --- 4. Sales ledger (mirrors recordMultiSellerSale) ---
  const ledger = {
    orderId: ORDER_DOC, orderNumber: ORDER_NUM,
    timestamp: ORDER_TS, year: 2026, month: 6, day: 11,
    customerId: '8WmxYeCp4PSym5iWHahgizokn5F2', customerEmail: 'davidhagon@gmail.com', customerName: 'Dave',
    artistId: submitterId, artistName: release.artistName || 'Various Artists',
    submitterId, submitterEmail,
    subtotal: 15, shipping: 0, discount: 0, grossTotal: 15,
    stripeFee: 0.48, paypalFee: 0, freshWaxFee: 0.15, totalFees: 0.63,
    netRevenue: 14.37, artistPayout: 14.37, artistPayoutStatus: 'pending',
    paymentMethod: 'stripe', paymentId: PAYMENT_INTENT, currency: 'GBP',
    itemCount: 1, hasPhysical: true, hasDigital: false,
    items: [{ type: 'vinyl', id: RELEASE_ID, title: correctedItem.title, artist: 'Various Artists', quantity: 1, unitPrice: 15, lineTotal: 15 }],
  };
  console.log('\n[4] Ledger entry: net £14.37 to', submitterId);

  // --- 5. Pending payout (mirrors processArtistPayments) ---
  const payout = {
    artistId: ARTIST_ID, artistName: 'Hangry Records', artistEmail: 'hangryrecords@gmail.com',
    orderId: ORDER_DOC, orderNumber: ORDER_NUM,
    amount: 19.43, itemAmount: 14.44, shippingAmount: 4.99,
    currency: 'gbp', status: 'pending', customerPaymentMethod: 'stripe',
    createdAt: ORDER_TS, updatedAt: new Date().toISOString(),
  };
  console.log('[5] Pending payout: £19.43 (item £14.44 + shipping £4.99) to Hangry Records; pendingBalance += 19.43');

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to write.'); return; }

  // --- APPLY ---
  await patchDoc(tok, `orders/${ORDER_DOC}`, { items: [correctedItem], shipping, totals, updatedAt: new Date().toISOString() });
  console.log('✓ order patched');
  await patchDoc(tok, `releases/${RELEASE_ID}`, { vinylParts: nextParts, updatedAt: new Date().toISOString() });
  console.log('✓ release stock updated');
  const moveId = await addDoc(tok, 'vinyl-stock-movements', movement);
  console.log('✓ stock movement', moveId);
  const ledgerId = await addDoc(tok, 'salesLedger', ledger);
  console.log('✓ salesLedger', ledgerId);
  const payoutId = await addDoc(tok, 'pendingPayouts', payout);
  console.log('✓ pendingPayouts', payoutId);
  await incrementField(tok, `artists/${ARTIST_ID}`, 'pendingBalance', 19.43);
  await patchDoc(tok, `artists/${ARTIST_ID}`, { updatedAt: new Date().toISOString() });
  console.log('✓ artist pendingBalance +19.43');

  // --- D1 SQL file for wrangler ---
  const entryWithId = { ...ledger, id: ledgerId };
  const sql = [
    `INSERT INTO sales_ledger (id, order_id, order_number, timestamp, year, month, day, customer_id, customer_email, artist_id, artist_name, submitter_id, submitter_email, subtotal, shipping, discount, gross_total, stripe_fee, paypal_fee, freshwax_fee, total_fees, net_revenue, artist_payout, artist_payout_status, payment_method, payment_id, currency, item_count, has_physical, has_digital, data) VALUES ('${sqlEsc(ledgerId)}', '${sqlEsc(ORDER_DOC)}', '${sqlEsc(ORDER_NUM)}', '${ORDER_TS}', 2026, 6, 11, '8WmxYeCp4PSym5iWHahgizokn5F2', 'davidhagon@gmail.com', ${submitterId ? `'${sqlEsc(submitterId)}'` : 'NULL'}, '${sqlEsc(ledger.artistName)}', ${submitterId ? `'${sqlEsc(submitterId)}'` : 'NULL'}, ${submitterEmail ? `'${sqlEsc(submitterEmail)}'` : 'NULL'}, 15, 0, 0, 15, 0.48, 0, 0.15, 0.63, 14.37, 14.37, 'pending', 'stripe', '${PAYMENT_INTENT}', 'GBP', 1, 1, 0, '${sqlEsc(JSON.stringify(entryWithId))}');`,
    `UPDATE releases_v2 SET data = json_set(data, '$.vinylParts[0].stock', ${newStock}, '$.vinylParts[0].sold', ${(Number(part1.sold) || 0) + 1}), updated_at = '${new Date().toISOString()}' WHERE id = '${RELEASE_ID}';`,
  ].join('\n');
  fs.writeFileSync(path.resolve(__dirname, 'repair-order-hpzi5x.sql'), sql);
  console.log('✓ wrote scripts/repair-order-hpzi5x.sql — run: npx wrangler d1 execute freshwax-db --remote --file scripts/repair-order-hpzi5x.sql');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
