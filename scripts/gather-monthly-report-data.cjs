// Gather real monthly report data for an artist/label and write it to
// a JSON file the report generator can read.
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

// Args: artistId, year, month (1-12)
const ARTIST_ID = process.argv[2] || 'OcnffhxjgTVvKkIDIG8zjujTOiY2';
const YEAR = parseInt(process.argv[3] || '2026', 10);
const MONTH = parseInt(process.argv[4] || '4', 10);
const PERIOD_START = new Date(Date.UTC(YEAR, MONTH - 1, 1));
const PERIOD_END = new Date(Date.UTC(YEAR, MONTH, 1));
const PRIOR_START = new Date(Date.UTC(YEAR, MONTH - 2, 1));
const PRIOR_END = new Date(Date.UTC(YEAR, MONTH - 1, 1));

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
async function getDoc(token, col, id) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}/${id}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
}
async function listCol(token, col, limit, where) {
  limit = limit || 500;
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const sq = { from: [{ collectionId: col }], limit };
  if (where) sq.where = where;
  const r = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: sq }) });
  return (await r.json()).filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
}

(async () => {
  const token = await getToken();
  console.log(`Gathering report data for artist ${ARTIST_ID}, period ${PERIOD_START.toISOString().slice(0,10)} → ${PERIOD_END.toISOString().slice(0,10)}\n`);

  // Artist profile
  const artist = await getDoc(token, 'artists', ARTIST_ID);
  console.log(`Artist: ${artist?.artistName || artist?.displayName || artist?.name || ARTIST_ID}`);
  console.log(`  Email: ${artist?.email}`);
  console.log(`  pendingBalance: £${artist?.pendingBalance || 0}`);

  // Sales ledger entries — all entries the dashboard would attribute to this artist
  const allLedger = await listCol(token, 'salesLedger', 500);
  const allReleases = await listCol(token, 'releases', 500);
  const myReleases = allReleases.filter(r => r.artistId === ARTIST_ID || r.userId === ARTIST_ID || r.submittedBy === ARTIST_ID);
  const myReleaseIds = new Set(myReleases.map(r => r.id));

  function matchesArtist(e) {
    if (e.submitterId === ARTIST_ID || e.artistId === ARTIST_ID) return true;
    if (e.items && Array.isArray(e.items)) {
      return e.items.some(it => {
        const rid = it.id || it.releaseId;
        return rid && myReleaseIds.has(rid);
      });
    }
    return false;
  }
  function inPeriod(ts, start, end) {
    if (!ts) return false;
    const d = new Date(ts);
    return d >= start && d < end;
  }

  const myLedger = allLedger.filter(matchesArtist);
  const myInPeriod = myLedger.filter(e => inPeriod(e.timestamp || e.createdAt, PERIOD_START, PERIOD_END));
  const myInPrior  = myLedger.filter(e => inPeriod(e.timestamp || e.createdAt, PRIOR_START, PRIOR_END));
  const myAllTime  = myLedger.filter(e => Number(e.artistPayout || 0) > 0); // skip £0 placeholders

  function summarise(rows) {
    let gross = 0, payout = 0, fwFee = 0, ppFee = 0, stripeFee = 0, paid = 0, pending = 0, count = 0;
    let units = 0;
    for (const r of rows) {
      gross += Number(r.grossTotal || 0);
      const pl = Number(r.artistPayout || 0);
      payout += pl;
      fwFee += Number(r.freshWaxFee || 0);
      ppFee += Number(r.paypalFee || 0);
      stripeFee += Number(r.stripeFee || 0);
      if (r.artistPayoutStatus === 'paid') paid += pl; else pending += pl;
      count++;
      units += (r.items && Array.isArray(r.items)) ? r.items.length : (Number(r.itemCount || 0) || 1);
    }
    return { gross, payout, fwFee, ppFee, stripeFee, paid, pending, count, units };
  }

  const period = summarise(myInPeriod);
  const prior = summarise(myInPrior);
  const lifetime = summarise(myAllTime);

  // First/last sale dates from lifetime ledger entries
  const lifetimeDates = myAllTime
    .map(e => e.timestamp || e.createdAt)
    .filter(Boolean)
    .map(ts => new Date(ts))
    .sort((a, b) => a - b);
  const firstSaleDate = lifetimeDates.length ? lifetimeDates[0].toISOString().slice(0, 10) : null;
  const lastSaleDate = lifetimeDates.length ? lifetimeDates[lifetimeDates.length - 1].toISOString().slice(0, 10) : null;
  const monthsActive = lifetimeDates.length
    ? new Set(lifetimeDates.map(d => `${d.getUTCFullYear()}-${d.getUTCMonth()}`)).size
    : 0;

  // All-time top releases (units across all entries)
  const lifetimeReleaseStats = new Map();
  for (const e of myAllTime) {
    for (const it of e.items || []) {
      const rid = it.id || it.releaseId;
      if (!rid || !myReleaseIds.has(rid)) continue;
      const cur = lifetimeReleaseStats.get(rid) || { id: rid, units: 0, gross: 0, title: it.title || '' };
      cur.units += Number(it.quantity || 1);
      cur.gross += Number(it.lineTotal || (Number(it.unitPrice || 0) * Number(it.quantity || 1)));
      cur.title = cur.title || it.title;
      lifetimeReleaseStats.set(rid, cur);
    }
  }
  const lifetimeTopReleases = Array.from(lifetimeReleaseStats.values())
    .sort((a, b) => b.units - a.units)
    .slice(0, 5)
    .map(r => {
      const rel = myReleases.find(x => x.id === r.id);
      return {
        title: rel?.title || r.title || r.id,
        artist: rel?.artistName || rel?.artist || '—',
        units: r.units,
        gross: Math.round(r.gross * 100) / 100,
      };
    });

  console.log(`\nPeriod ledger entries: ${myInPeriod.length}`);
  console.log(`  gross: £${period.gross.toFixed(2)}, payout: £${period.payout.toFixed(2)}, pending: £${period.pending.toFixed(2)}, paid: £${period.paid.toFixed(2)}`);
  console.log(`Prior month: ${prior.count} entries, gross £${prior.gross.toFixed(2)}, payout £${prior.payout.toFixed(2)}`);

  // Daily revenue (from period ledger)
  const dayMs = 24 * 3600 * 1000;
  const days = Math.round((PERIOD_END - PERIOD_START) / dayMs);
  const daily = new Array(days).fill(0);
  for (const e of myInPeriod) {
    const d = new Date(e.timestamp || e.createdAt);
    const idx = Math.floor((d - PERIOD_START) / dayMs);
    if (idx >= 0 && idx < days) daily[idx] += Number(e.grossTotal || 0);
  }

  // Top releases — by units sold across period entries' items
  const releaseStats = new Map();
  for (const e of myInPeriod) {
    for (const it of e.items || []) {
      const rid = it.id || it.releaseId;
      if (!rid) continue;
      // Only count items belonging to this artist
      if (!myReleaseIds.has(rid)) continue;
      const cur = releaseStats.get(rid) || { id: rid, units: 0, gross: 0, title: it.title || '' };
      cur.units += Number(it.quantity || 1);
      cur.gross += Number(it.lineTotal || (Number(it.unitPrice || 0) * Number(it.quantity || 1)));
      cur.title = cur.title || it.title;
      releaseStats.set(rid, cur);
    }
  }
  // Enrich with release name + artist
  const topReleases = Array.from(releaseStats.values()).sort((a, b) => b.units - a.units).slice(0, 8).map(r => {
    const rel = myReleases.find(x => x.id === r.id);
    return {
      title: rel?.title || r.title || r.id,
      artist: rel?.artistName || rel?.artist || '—',
      units: r.units,
      gross: r.gross,
    };
  });

  // Sales by category — best effort from item.type
  const cats = { 'Digital Releases': { units: 0, gross: 0 }, 'Merch': { units: 0, gross: 0 }, 'Vinyl': { units: 0, gross: 0 } };
  for (const e of myInPeriod) {
    for (const it of e.items || []) {
      const t = (it.type || 'release').toLowerCase();
      const bucket = t === 'merch' ? 'Merch' : t === 'vinyl' ? 'Vinyl' : 'Digital Releases';
      cats[bucket].units += Number(it.quantity || 1);
      cats[bucket].gross += Number(it.lineTotal || (Number(it.unitPrice || 0) * Number(it.quantity || 1)));
    }
  }
  const totalGrossAll = Object.values(cats).reduce((s, c) => s + c.gross, 0) || 1;
  const byCategory = Object.entries(cats)
    .filter(([_, c]) => c.units > 0)
    .map(([type, c]) => ({ type, units: c.units, gross: c.gross, share: Math.round((c.gross / totalGrossAll) * 1000) / 10 }));

  // DJ mixes — sum plays for this artist's mixes (if they're a DJ)
  const allMixes = await listCol(token, 'dj-mixes', 500);
  const myMixes = allMixes.filter(m => m.djId === ARTIST_ID || m.userId === ARTIST_ID);
  const totalPlays = myMixes.reduce((s, m) => s + Number(m.plays || 0), 0);

  // Followers — try users doc field
  const userDoc = await getDoc(token, 'users', ARTIST_ID);
  const followerCount = userDoc?.followerCount || artist?.followerCount || 0;

  // Pending payouts collection — for status display
  const allPending = await listCol(token, 'pendingPayouts', 500);
  const myPending = allPending.filter(p => (p.sellerId || p.artistId) === ARTIST_ID);
  const pendingTotal = myPending.filter(p => p.status === 'pending').reduce((s, p) => s + Number(p.amount || 0), 0);

  // Recent payouts (from payouts collection if it exists)
  const allPayouts = await listCol(token, 'payouts', 200).catch(() => []);
  const myPayouts = allPayouts.filter(p => (p.artistId || p.sellerId || p.recipientId) === ARTIST_ID);
  const recentPayouts = myPayouts.sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || '')).slice(0, 5);

  // Order list for context
  const allOrders = await listCol(token, 'orders', 200);
  const periodOrders = allOrders.filter(o => {
    if (!o.createdAt) return false;
    const d = new Date(o.createdAt);
    return d >= PERIOD_START && d < PERIOD_END;
  });
  const myOrders = periodOrders.filter(o => myInPeriod.some(e => e.orderId === o.id));

  const out = {
    artistId: ARTIST_ID,
    artistName: artist?.artistName || artist?.displayName || artist?.name || ARTIST_ID,
    artistEmail: artist?.email || '—',
    period: PERIOD_START.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
    periodStart: PERIOD_START.toISOString().slice(0, 10),
    periodEnd: new Date(PERIOD_END.getTime() - dayMs).toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    // top-line
    totalSales: period.count,
    totalUnits: period.units,
    grossRevenue: Math.round(period.gross * 100) / 100,
    freshWaxFee: Math.round(period.fwFee * 100) / 100,
    paymentProcessingFee: Math.round((period.ppFee + period.stripeFee) * 100) / 100,
    refunds: 0,
    netEarnings: Math.round(period.payout * 100) / 100,
    pendingBalance: Math.round((artist?.pendingBalance || pendingTotal) * 100) / 100,
    paidOutThisMonth: Math.round(period.paid * 100) / 100,
    prior: {
      totalSales: prior.count,
      grossRevenue: Math.round(prior.gross * 100) / 100,
      netEarnings: Math.round(prior.payout * 100) / 100,
    },
    lifetime: {
      totalSales: lifetime.count,
      totalUnits: lifetime.units,
      grossRevenue: Math.round(lifetime.gross * 100) / 100,
      netEarnings: Math.round(lifetime.payout * 100) / 100,
      paidOut: Math.round(lifetime.paid * 100) / 100,
      pending: Math.round(lifetime.pending * 100) / 100,
      firstSaleDate,
      lastSaleDate,
      monthsActive,
      topReleases: lifetimeTopReleases,
    },
    dailyRevenue: daily.map(v => Math.round(v * 100) / 100),
    byCategory,
    topReleases,
    catalogSize: myReleases.length,
    listenerStats: {
      totalPlays,
      mixCount: myMixes.length,
      totalFollowers: followerCount,
    },
    pendingPayoutRows: myPending.filter(p => p.status === 'pending').map(p => ({
      orderNumber: p.orderNumber,
      amount: Math.round(Number(p.amount || 0) * 100) / 100,
      createdAt: p.createdAt,
      paymentMethod: p.customerPaymentMethod || 'paypal',
    })),
    recentPayouts: recentPayouts.map(p => ({
      date: (p.createdAt || p.date || '').slice(0, 10),
      amount: Math.round(Number(p.amount || 0) * 100) / 100,
      method: p.method || p.paymentMethod || 'PayPal',
      status: p.status || 'paid',
    })),
    orders: myOrders.map(o => ({
      orderNumber: o.orderNumber,
      createdAt: (o.createdAt || '').slice(0, 10),
      total: Number((o.totals && o.totals.total) || o.total || 0),
      itemCount: (o.items || []).filter(it => myReleaseIds.has(it.releaseId || it.productId || it.id)).length,
    })),
  };

  const outPath = path.resolve(__dirname, 'monthly-report-data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log('\nKey figures:');
  console.log('  Gross:', '£' + out.grossRevenue.toFixed(2));
  console.log('  Net:', '£' + out.netEarnings.toFixed(2));
  console.log('  Sales (orders):', out.totalSales);
  console.log('  Units:', out.totalUnits);
  console.log('  Catalog:', out.catalogSize, 'releases');
  console.log('  Plays (mixes):', out.listenerStats.totalPlays);
  console.log('  Followers:', out.listenerStats.totalFollowers);
  console.log('  Top release (period):', out.topReleases[0] ? `${out.topReleases[0].title} — ${out.topReleases[0].units} units · £${out.topReleases[0].gross.toFixed(2)}` : '(none)');
  console.log('\nAll-time:');
  console.log('  First sale:', out.lifetime.firstSaleDate || 'never');
  console.log('  Last sale:', out.lifetime.lastSaleDate || 'never');
  console.log('  Months active:', out.lifetime.monthsActive);
  console.log('  Lifetime gross:', '£' + out.lifetime.grossRevenue.toFixed(2));
  console.log('  Lifetime net:', '£' + out.lifetime.netEarnings.toFixed(2));
  console.log('  Lifetime sales:', out.lifetime.totalSales, '·', out.lifetime.totalUnits, 'units');
  console.log('  Lifetime top:', out.lifetime.topReleases[0] ? `${out.lifetime.topReleases[0].title} — ${out.lifetime.topReleases[0].units} units` : '(none)');
})().catch(e => { console.error(e); process.exit(1); });
