// One-shot: restore the full Curiosity Vol.2 tracklist to Oren's
// "Twisted Assasin" line item (per user request — he keeps the comp as a
// goodwill gesture; the underlying bug is fixed for everyone going forward).
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
const ORDER_ID = 'SwRRRkCavbWH4zlLuRsL';
const RELEASE_ID = 'underground_lair_recordings_FW-1768518251667';

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

  // Pull the release tracklist
  const relRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${RELEASE_ID}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!relRes.ok) { console.error('Failed to fetch release:', relRes.status); process.exit(1); }
  const relDoc = await relRes.json();
  const relFields = relDoc.fields || {};
  const tracks = parseVal(relFields.tracks) || [];
  const fullTrackList = tracks.map((t) => ({
    name: t.trackName || t.name || '',
    mp3Url: t.mp3Url || null,
    wavUrl: t.wavUrl || null,
  }));
  console.log(`Release has ${fullTrackList.length} tracks.`);

  // Pull the order
  const orderUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/orders/${ORDER_ID}`;
  const ordRes = await fetch(orderUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!ordRes.ok) { console.error('Failed to fetch order:', ordRes.status); process.exit(1); }
  const ordDoc = await ordRes.json();
  const items = parseVal(ordDoc.fields?.items) || [];

  let touched = false;
  const newItems = items.map((item) => {
    const releaseId = item.releaseId || item.productId || item.id;
    if (releaseId !== RELEASE_ID || item.type !== 'track') return item;

    console.log(`Restoring all tracks on item: ${item.name}`);
    touched = true;
    return {
      ...item,
      downloads: {
        ...(item.downloads || {}),
        tracks: fullTrackList,
      },
    };
  });

  if (!touched) {
    console.log('No matching item found — nothing to restore.');
    return;
  }

  const patchUrl = `${orderUrl}?updateMask.fieldPaths=items&updateMask.fieldPaths=updatedAt`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { items: toFsValue(newItems), updatedAt: { timestampValue: new Date().toISOString() } } }),
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    console.error('Patch failed:', patchRes.status, err);
    process.exit(1);
  }
  console.log('Order updated.');
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
