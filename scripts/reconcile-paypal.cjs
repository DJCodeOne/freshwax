// Reconcile current PayPal merchant balance against FreshWax ledger.
// Tells you whether you're in profit, breaking even, or at a loss,
// and flags any unexplained gap between expected balance and actual.
//
// Usage: node scripts/reconcile-paypal.cjs <currentPaypalBalanceGBP>
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

const balanceArg = parseFloat(process.argv[2]);
const HAS_BALANCE_ARG = !Number.isNaN(balanceArg);

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
function gbp(n) { return (n < 0 ? '-' : '') + '£' + Math.abs(Number(n || 0)).toFixed(2); }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function rule(c, n) { return c.repeat(n); }

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

  // Resolve PayPal balance: arg wins, else read from treasury/paypal Firestore doc.
  let PAYPAL_BALANCE = balanceArg;
  let balanceSource = 'argument';
  let balanceRecordedAt = null;
  if (!HAS_BALANCE_ARG) {
    try {
      const tr = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/treasury/paypal`, { headers: { Authorization: 'Bearer ' + token } });
      if (tr.ok) {
        const j = await tr.json();
        const f = Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
        if (typeof f.balance === 'number') {
          PAYPAL_BALANCE = f.balance;
          balanceSource = 'treasury/paypal';
          balanceRecordedAt = f.recordedAt;
        }
      }
    } catch (_) { /* fall through */ }
  }
  if (Number.isNaN(PAYPAL_BALANCE) || PAYPAL_BALANCE === undefined) {
    console.error('No PayPal balance available. Pass as argument or record one with:');
    console.error('  node scripts/record-treasury-balance.cjs <balance>');
    process.exit(1);
  }

  // Pull all paid orders, salesLedger, pendingPayouts
  async function listCol(col, limit) {
    const r = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], limit: limit || 500 } }) });
    return (await r.json()).filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
  }

  const [orders, ledger, pendingPayouts] = await Promise.all([
    listCol('orders', 200),
    listCol('salesLedger', 500),
    listCol('pendingPayouts', 500),
  ]);

  // Filter to PayPal-paid orders that actually completed
  const paypalOrders = orders.filter(o =>
    (o.paymentMethod === 'paypal' || o.paymentMethod === 'paypal_manual')
    && (o.paymentStatus === 'completed' || o.orderStatus === 'completed' || o.status === 'completed' || o.status === 'paid')
    && Number((o.totals && o.totals.total) || o.total || 0) > 0
  );

  // Customer revenue (gross)
  let customerRevenue = 0;
  for (const o of paypalOrders) customerRevenue += Number((o.totals && o.totals.total) || o.total || 0);

  // PayPal merchant fees per order: 2.9% + £0.30
  const PAYPAL_FEE_RATE = 0.029, PAYPAL_FEE_FIXED = 0.30;
  let paypalMerchantFees = 0;
  for (const o of paypalOrders) {
    const t = Number((o.totals && o.totals.total) || o.total || 0);
    paypalMerchantFees += (t * PAYPAL_FEE_RATE) + PAYPAL_FEE_FIXED;
  }
  const fwReceivedFromPaypal = customerRevenue - paypalMerchantFees;

  // FreshWax 1% platform fee retained
  const fwPlatformFee = customerRevenue * 0.01;

  // Total artist obligation (per ledger, dedupe by id)
  // Skip £0 placeholder rows.
  const realLedger = ledger.filter(e => Number(e.artistPayout || 0) > 0);
  const totalArtistPayoutOwed = realLedger.reduce((s, e) => s + Number(e.artistPayout || 0), 0);
  const paidLedger = realLedger.filter(e => e.artistPayoutStatus === 'paid');
  const pendingLedger = realLedger.filter(e => e.artistPayoutStatus !== 'paid');
  const alreadyPaid = paidLedger.reduce((s, e) => s + Number(e.artistPayout || 0), 0);
  const stillPending = pendingLedger.reduce((s, e) => s + Number(e.artistPayout || 0), 0);

  // Expected PayPal balance =
  //   what FreshWax has received from PayPal customer payments
  //   minus payouts already issued (which leave PayPal too)
  const expectedBalance = fwReceivedFromPaypal - alreadyPaid;

  // Theoretical FW profit (the 1% platform fee minus any over-payout)
  const fwIdealKeep = customerRevenue - paypalMerchantFees - totalArtistPayoutOwed;

  // Print report
  const W = 78;
  console.log(rule('=', W));
  console.log(pad('FreshWax × PayPal Reconciliation', W));
  console.log(pad(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' (UTC)', W));
  console.log(pad(`PayPal balance source: ${balanceSource}${balanceRecordedAt ? ' · recorded ' + balanceRecordedAt.slice(0, 19).replace('T', ' ') : ''}`, W));
  console.log(rule('=', W));

  console.log('\n[ Customer side — money in ]');
  console.log(`  PayPal orders completed (lifetime):          ${paypalOrders.length}`);
  console.log(`  Total customer revenue (gross):              ${gbp(customerRevenue)}`);
  console.log(`  PayPal merchant fees (2.9% + £0.30/order):   ${gbp(-paypalMerchantFees)}`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  FreshWax received into PayPal:               ${gbp(fwReceivedFromPaypal)}`);

  console.log('\n[ Artist side — money out (or owed) ]');
  console.log(`  Total artist payout obligation (lifetime):   ${gbp(totalArtistPayoutOwed)}`);
  console.log(`    └ Already paid out:                        ${gbp(alreadyPaid)}`);
  console.log(`    └ Still pending:                           ${gbp(stillPending)}`);

  console.log('\n[ FreshWax balance check ]');
  console.log(`  Expected PayPal balance:                     ${gbp(expectedBalance)}`);
  console.log(`    (fwReceivedFromPaypal − alreadyPaid)`);
  console.log(`  Actual PayPal balance you reported:          ${gbp(PAYPAL_BALANCE)}`);
  const gap = PAYPAL_BALANCE - expectedBalance;
  const gapMsg = Math.abs(gap) < 0.05
    ? '✓ Match (within £0.05 rounding)'
    : gap < 0
      ? `Gap: ${gbp(gap)} — actual is LOWER than expected`
      : `Gap: ${gbp(gap)} — actual is HIGHER than expected`;
  console.log(`  Reconciliation gap:                          ${gapMsg}`);

  console.log('\n[ Profit / Loss assessment ]');
  console.log(`  Lifetime customer revenue:                   ${gbp(customerRevenue)}`);
  console.log(`  PayPal merchant fees (cost to FW):           ${gbp(-paypalMerchantFees)}`);
  console.log(`  Artist payouts (cost to FW):                 ${gbp(-totalArtistPayoutOwed)}`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  FreshWax net position:                       ${gbp(fwIdealKeep)}`);
  if (Math.abs(fwIdealKeep) < 0.10) {
    console.log(`                                               ⚖  BREAK-EVEN`);
  } else if (fwIdealKeep > 0) {
    console.log(`                                               ✓ PROFIT`);
  } else {
    console.log(`                                               ✗ LOSS`);
  }

  // Cash position vs liability
  console.log('\n[ Cash position vs liability ]');
  console.log(`  Cash on hand (PayPal balance):               ${gbp(PAYPAL_BALANCE)}`);
  console.log(`  Outstanding artist liability (pending):      ${gbp(-stillPending)}`);
  const cashAfterLiability = PAYPAL_BALANCE - stillPending;
  console.log(`  Cash after settling all pending payouts:     ${gbp(cashAfterLiability)}`);
  if (cashAfterLiability < 0) {
    console.log(`  ⚠  Pending obligations exceed PayPal cash by ${gbp(-cashAfterLiability)}`);
  }

  // Per-order breakdown
  console.log('\n[ Per-order breakdown ]');
  console.log(`  ${pad('Order #', 22)} ${pad('Date', 12)} ${pad('Gross', 8)} ${pad('PayPal Fee', 12)} ${pad('FW Net', 8)}`);
  console.log('  ' + rule('-', W - 2));
  const sortedOrders = paypalOrders.slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const o of sortedOrders) {
    const t = Number((o.totals && o.totals.total) || o.total || 0);
    const fee = (t * PAYPAL_FEE_RATE) + PAYPAL_FEE_FIXED;
    const netToFw = t - fee;
    console.log(`  ${pad(o.orderNumber || o.id.slice(0, 18), 22)} ${pad((o.createdAt || '').slice(0, 10), 12)} ${pad(gbp(t), 8)} ${pad(gbp(-fee), 12)} ${pad(gbp(netToFw), 8)}`);
  }
  console.log('  ' + rule('-', W - 2));
  console.log(`  ${pad('TOTAL', 22)} ${pad('', 12)} ${pad(gbp(customerRevenue), 8)} ${pad(gbp(-paypalMerchantFees), 12)} ${pad(gbp(fwReceivedFromPaypal), 8)}`);

  console.log('\n' + rule('=', W));
  console.log('\nNotes:');
  console.log('  · PayPal fee assumes 2.9% + £0.30 per order (UK Commercial). Actual');
  console.log('    fees may vary slightly for chargebacks, currency conversion, or older');
  console.log('    rate cards. Cross-reference with the PayPal Activity report for exact.');
  console.log('  · "Already paid out" includes only payouts that ledger marks as paid');
  console.log('    (artistPayoutStatus = paid). Sending payouts via PayPal Mass Pay also');
  console.log('    incurs a small per-recipient fee that PayPal deducts from the');
  console.log('    recipient — not reflected in this reconciliation.');
  console.log('  · Reconciliation gap usually has a few sources: bank transfers out of');
  console.log('    PayPal, non-FreshWax PayPal activity (personal, services), refunds,');
  console.log('    or chargebacks. PayPal Activity export will show every line.');
})().catch(e => { console.error(e); process.exit(1); });
