// Simulate src/pages/artist/account.astro logic for each label/artist
// to see what they'll actually display when they sign in.
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
async function listCol(token, col, limit, filters) {
  limit = limit || 500;
  const FB = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents:runQuery';
  const sq = { from: [{ collectionId: col }], limit };
  if (filters && filters.length) {
    sq.where = { compositeFilter: { op: 'AND', filters: filters.map(f => ({ fieldFilter: { field: { fieldPath: f.field }, op: 'EQUAL', value: { stringValue: f.value } } })) } };
  }
  const r = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: sq }) });
  return (await r.json()).filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
}

const ARTISTS = [
  { id: '8WmxYeCp4PSym5iWHahgizokn5F2', name: 'Code One' },
  { id: 'CCMDrCWRkUXiPN7O83iSfm1BxGo1', name: 'Bakkus Recordings' },
  { id: 'OcnffhxjgTVvKkIDIG8zjujTOiY2', name: 'Underground Lair Recordings' },
  { id: 'BNpWXqfKDoOCXHKN2IqfxWcHtBv2', name: 'Y2 - Danger Chamber' },
];

(async () => {
  const token = await getToken();
  // Fetch globally once
  const [allLedger, allReleases] = await Promise.all([
    listCol(token, 'salesLedger', 500),
    listCol(token, 'releases', 500),
  ]);

  for (const partner of ARTISTS) {
    const partnerId = partner.id;

    const artistReleases = allReleases.filter(r => r.artistId === partnerId || r.userId === partnerId || r.submittedBy === partnerId);
    const artistReleaseIds = new Set(artistReleases.map(r => r.id));

    // Filter ledger as the dashboard does
    const ledgerEntries = allLedger.filter(e => {
      if (e.submitterId === partnerId || e.artistId === partnerId) return true;
      if (e.items && Array.isArray(e.items)) {
        return e.items.some(item => {
          const releaseId = item.id || item.releaseId;
          return releaseId && artistReleaseIds.has(releaseId);
        });
      }
      if (e.releaseId && artistReleaseIds.has(e.releaseId)) return true;
      return false;
    });

    let totalEarnings = 0;
    let totalPaidOut = 0;
    for (const e of ledgerEntries) {
      const payout = Number(e.artistPayout || e.actualArtistPayout || 0);
      totalEarnings += payout;
      if (e.artistPayoutStatus === 'paid') totalPaidOut += Number(e.artistPayoutPaid || payout);
    }
    let pendingBalance = totalEarnings - totalPaidOut;

    // Pending payouts (filtered server-side by artistId+pending)
    const pendingPayouts = await listCol(token, 'pendingPayouts', 200, [
      { field: 'artistId', value: partnerId },
      { field: 'status', value: 'pending' },
    ]);
    let pendingAdded = 0;
    for (const p of pendingPayouts) {
      const amount = Number(p.amount || 0);
      const existing = ledgerEntries.find(e => e.orderId === p.orderId);
      const existingAmt = existing ? Number(existing.artistPayout || existing.actualArtistPayout || 0) : 0;
      if (!existing || existingAmt === 0) {
        pendingBalance += amount;
        totalEarnings += amount;
        pendingAdded += amount;
      }
    }

    console.log('==', partner.name, '(' + partnerId.slice(-6) + ') ==');
    console.log('  releaseIds owned:', artistReleaseIds.size);
    console.log('  matched ledger entries:', ledgerEntries.length);
    for (const e of ledgerEntries) {
      const payout = Number(e.artistPayout || e.actualArtistPayout || 0);
      const matchedBy = (e.submitterId === partnerId || e.artistId === partnerId) ? 'submitter' : 'item';
      console.log('    -', e.id, '| order=' + (e.orderNumber || e.orderId), '| £' + payout.toFixed(2), '| status=' + e.artistPayoutStatus, '| matchedBy=' + matchedBy);
    }
    console.log('  pendingPayouts (artistId=' + partnerId.slice(-6) + ', status=pending):', pendingPayouts.length, '— added £' + pendingAdded.toFixed(2));
    console.log('  ===> Dashboard will show:');
    console.log('     Total Earnings:  £' + totalEarnings.toFixed(2));
    console.log('     Total Paid Out:  £' + totalPaidOut.toFixed(2));
    console.log('     Pending Balance: £' + pendingBalance.toFixed(2));
    console.log('');
  }
})().catch(e => { console.error(e); process.exit(1); });
