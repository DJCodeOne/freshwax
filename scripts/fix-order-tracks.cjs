// Fix orders where single-track purchases were saved with the full release's
// track list (the create-order fallback before commit fixing this bug).
// Re-runs the matching against current release data and rewrites
// item.downloads.tracks to the correct single track per item.
//
// Usage:
//   node scripts/fix-order-tracks.cjs <orderId>          (single order)
//   node scripts/fix-order-tracks.cjs --uid <uid>        (every order for a user)
//   node scripts/fix-order-tracks.cjs --dry-run --uid <uid>
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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
let orderId = null;
let uid = null;
const uidIdx = args.indexOf('--uid');
if (uidIdx >= 0) {
  uid = args[uidIdx + 1];
} else {
  orderId = args.find((a) => !a.startsWith('--')) || null;
}
if (!orderId && !uid) {
  console.error('usage: node scripts/fix-order-tracks.cjs <orderId> | --uid <uid> [--dry-run]');
  process.exit(1);
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

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

const releaseCache = new Map();
async function getRelease(token, releaseId) {
  if (releaseCache.has(releaseId)) return releaseCache.get(releaseId);
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${releaseId}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) { releaseCache.set(releaseId, null); return null; }
  const doc = await res.json();
  const f = doc.fields || {};
  const out = {
    releaseName: parseVal(f.releaseName) || parseVal(f.title),
    artistName: parseVal(f.artistName),
    coverArtUrl: parseVal(f.coverArtUrl) || parseVal(f.originalArtworkUrl),
    tracks: parseVal(f.tracks) || [],
  };
  releaseCache.set(releaseId, out);
  return out;
}

function findTrack(item, releaseTracks) {
  let trackIdSuffixNum = null;
  if (item.trackId) {
    const m = String(item.trackId).match(/-track-(\d+)$/);
    if (m) trackIdSuffixNum = parseInt(m[1], 10);
  }
  let track = null;
  if (item.trackId) {
    track = releaseTracks.find((t) => t.id === item.trackId || t.trackId === item.trackId || String(t.trackNumber) === String(item.trackId)) || null;
    if (!track && trackIdSuffixNum != null) {
      track = releaseTracks.find((t) =>
        Number(t.trackNumber) === trackIdSuffixNum ||
        Number(t.trackNumber) === trackIdSuffixNum - 1 ||
        Number(t.displayTrackNumber) === trackIdSuffixNum
      ) || null;
    }
  }
  const splitTrailing = (s) => { const parts = s.split(' - '); return parts.length > 1 ? parts.slice(1).join(' - ') : s; };
  const candidates = [item.title, item.name ? splitTrailing(item.name) : null].filter(Boolean).map((s) => s.toLowerCase().trim());
  if (!track && candidates.length) {
    track = releaseTracks.find((t) => { const n = (t.trackName || t.name || '').toLowerCase().trim(); return candidates.some((c) => n === c); }) || null;
  }
  if (!track && candidates.length) {
    track = releaseTracks.find((t) => { const n = (t.trackName || t.name || '').toLowerCase(); return candidates.some((c) => c.length >= 3 && n.includes(c)); }) || null;
  }
  return track;
}

async function processOrder(token, orderId) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/orders/${orderId}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) { console.log(`Order ${orderId}: not found`); return false; }
  const doc = await res.json();
  const items = parseVal(doc.fields?.items) || [];
  let changed = false;
  const newItems = [];
  for (const item of items) {
    const isSingleTrack = item.type === 'track';
    const tracks = item.downloads?.tracks || [];
    if (!isSingleTrack || tracks.length <= 1) {
      newItems.push(item);
      continue;
    }
    const releaseId = item.releaseId || item.productId || item.id;
    const release = await getRelease(token, releaseId);
    if (!release) {
      console.log(`  [skip] Release ${releaseId} not found for item ${item.name}`);
      newItems.push(item);
      continue;
    }
    const matched = findTrack(item, release.tracks);
    if (!matched) {
      console.log(`  [unmatched] ${item.name} (trackId=${item.trackId}) — leaving as-is, manual review needed`);
      newItems.push(item);
      continue;
    }
    const fixed = {
      ...item,
      downloads: {
        ...(item.downloads || {}),
        tracks: [{
          name: matched.trackName || matched.name || item.title || item.name,
          mp3Url: matched.mp3Url || null,
          wavUrl: matched.wavUrl || null,
        }],
      },
    };
    console.log(`  [fix] ${item.name}: ${tracks.length} tracks -> 1 (${fixed.downloads.tracks[0].name})`);
    newItems.push(fixed);
    changed = true;
  }
  if (!changed) { console.log(`Order ${orderId}: no changes needed`); return false; }
  if (dryRun) { console.log(`Order ${orderId}: DRY RUN — would write ${newItems.length} items`); return true; }
  const patchUrl = `${url}?updateMask.fieldPaths=items&updateMask.fieldPaths=updatedAt`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { items: toFsValue(newItems), updatedAt: { timestampValue: new Date().toISOString() } } }),
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    console.log(`Order ${orderId}: patch failed:`, patchRes.status, err);
    return false;
  }
  console.log(`Order ${orderId}: WRITTEN`);
  return true;
}

(async () => {
  const token = await getToken();
  const targets = [];
  if (orderId) targets.push(orderId);
  if (uid) {
    const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
    const q = {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        where: { fieldFilter: { field: { fieldPath: 'customer.userId' }, op: 'EQUAL', value: { stringValue: uid } } },
        orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
        limit: 50,
      },
    };
    const r = await fetch(FB, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    const arr = await r.json();
    for (const row of arr) {
      if (row.document) targets.push(row.document.name.split('/').pop());
    }
    console.log(`Found ${targets.length} orders for uid=${uid}`);
  }
  let fixed = 0;
  for (const id of targets) {
    console.log(`\n=== ${id} ===`);
    if (await processOrder(token, id)) fixed++;
  }
  console.log(`\nDone. ${fixed} order(s) ${dryRun ? '(would be) ' : ''}fixed.`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
