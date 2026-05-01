// Fix backfilled salesLedger entries so they don't over-match other artists
// in the artist/account.astro dashboard filter. The dashboard matches a
// ledger entry to an artist if ANY item's releaseId is in that artist's
// owned releases — when a multi-payee order's items[] is duplicated across
// per-seller entries, every co-seller sees every entry as theirs and the
// pendingBalance triples.
//
// Per-entry rule: items[] should contain only items where the underlying
// release.artistId === this entry's submitterId. Split-recipients (entries
// where submitterId comes from payoutSplits, not release.artistId) get
// items=[] so they only match their own filter via submitterId.
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

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  const FB = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents:runQuery';

  // Fetch all backfilled entries (we marked them with backfillSource:'pendingPayouts')
  const lr = await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'salesLedger' }], where: { fieldFilter: { field: { fieldPath: 'backfillSource' }, op: 'EQUAL', value: { stringValue: 'pendingPayouts' } } }, limit: 100 } }) });
  const ledgerRaw = await lr.json();
  const backfilled = ledgerRaw.filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));

  console.log('Found', backfilled.length, 'backfilled entries');

  // Cache release lookups
  const releaseCache = new Map();
  async function getRelease(id) {
    if (releaseCache.has(id)) return releaseCache.get(id);
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${id}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { releaseCache.set(id, null); return null; }
    const j = await r.json();
    const doc = Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, parseVal(v)]));
    releaseCache.set(id, doc);
    return doc;
  }

  for (const entry of backfilled) {
    const submitterId = entry.submitterId || entry.artistId;
    const items = Array.isArray(entry.items) ? entry.items : [];
    console.log('\n[' + entry.id + '] submitter=' + submitterId);
    console.log('  current items:', items.length);

    // For each item, look up the release and check if release.artistId === submitterId
    const filtered = [];
    for (const it of items) {
      const releaseId = it.id || it.releaseId || it.productId;
      if (!releaseId) continue;
      const release = await getRelease(releaseId);
      if (!release) continue;
      const owner = release.artistId || release.userId || release.submittedBy;
      const include = owner === submitterId;
      console.log('    -', releaseId, '"' + (it.title || '?') + '" owner=' + owner, include ? 'KEEP' : 'drop (split-recipient)');
      if (include) filtered.push(it);
    }

    console.log('  -> new items count:', filtered.length);

    if (APPLY) {
      const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/salesLedger/${entry.id}?updateMask.fieldPaths=items&updateMask.fieldPaths=itemsScopedAt`;
      const body = { fields: { items: toFsValue(filtered), itemsScopedAt: { timestampValue: new Date().toISOString() } } };
      const w = await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!w.ok) console.error('    PATCH FAILED:', w.status, await w.text());
      else console.log('    PATCHED');
    }
  }

  if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');
})().catch(e => { console.error(e); process.exit(1); });
