// Sync Firestore salesLedger → D1 sales_ledger via INSERT OR REPLACE.
// Use after manual Firestore writes (backfills, splits, fee rebalances)
// to keep the D1 mirror in sync. Idempotent — INSERT OR REPLACE on doc id.
//
// Generates a .sql file that we then pipe through wrangler d1 execute.
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
function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlNum(v) {
  if (v === null || v === undefined) return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}
function sqlBool(v) { return v ? '1' : '0'; }

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const r = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'salesLedger' }], limit: 500 } }) });
  const arr = (await r.json()).filter(x => x.document);
  console.log(`Fetched ${arr.length} Firestore salesLedger entries`);

  const stmts = [];
  let skipped = 0;
  for (const x of arr) {
    const id = x.document.name.split('/').pop();
    const e = Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]));
    e.id = id;

    // Some legacy orphan entries have null orderId. D1 has a NOT NULL
    // constraint on order_id, so we fall back to the doc-id stripped of the
    // `ledger_` prefix. If even that doesn't work, skip — these are usually
    // £0 paid placeholders that don't affect reconciliation.
    if (!e.orderId) {
      const fallback = id.startsWith('ledger_') ? id.slice('ledger_'.length) : null;
      if (fallback) e.orderId = fallback;
      else { skipped++; continue; }
    }

    const ts = e.timestamp || e.createdAt || new Date().toISOString();
    const d = new Date(ts);
    const stmt = `INSERT OR REPLACE INTO sales_ledger (id, order_id, order_number, timestamp, year, month, day, customer_id, customer_email, artist_id, artist_name, submitter_id, submitter_email, subtotal, shipping, discount, gross_total, stripe_fee, paypal_fee, freshwax_fee, total_fees, net_revenue, artist_payout, artist_payout_status, payment_method, payment_id, currency, item_count, has_physical, has_digital, data) VALUES (` +
      [
        sqlStr(id),
        sqlStr(e.orderId),
        sqlStr(e.orderNumber),
        sqlStr(ts),
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate(),
        sqlStr(e.customerId),
        sqlStr(e.customerEmail),
        sqlStr(e.artistId),
        sqlStr(e.artistName),
        sqlStr(e.submitterId || e.artistId),
        sqlStr(e.submitterEmail),
        sqlNum(e.subtotal),
        sqlNum(e.shipping || 0),
        sqlNum(e.discount || 0),
        sqlNum(e.grossTotal),
        sqlNum(e.stripeFee || 0),
        sqlNum(e.paypalFee || 0),
        sqlNum(e.freshWaxFee || 0),
        sqlNum(e.totalFees || 0),
        sqlNum(e.netRevenue || e.artistPayout),
        sqlNum(e.artistPayout),
        sqlStr(e.artistPayoutStatus || 'pending'),
        sqlStr(e.paymentMethod),
        sqlStr(e.paymentId),
        sqlStr(e.currency || 'GBP'),
        Number(e.itemCount || 0),
        sqlBool(e.hasPhysical),
        sqlBool(e.hasDigital),
        sqlStr(JSON.stringify(e)),
      ].join(', ') + ');';
    stmts.push(stmt);
  }

  const sqlPath = path.resolve(__dirname, 'sync-sales-ledger.sql');
  fs.writeFileSync(sqlPath, stmts.join('\n') + '\n');
  console.log(`Wrote ${stmts.length} statements to ${sqlPath} (skipped ${skipped} orphan)`);
  console.log(`Apply with:\n  npx wrangler d1 execute freshwax-db --remote --file=scripts/sync-sales-ledger.sql`);
})().catch(e => { console.error(e); process.exit(1); });
