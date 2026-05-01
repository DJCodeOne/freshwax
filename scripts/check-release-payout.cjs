// Inspect a release's payout-routing fields (artistId, userId, labelName, etc).
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
const RELEASE_ID = process.argv[2] || 'underground_lair_recordings_FW-1768518251667';

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
(async () => {
  const token = await getToken();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${RELEASE_ID}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const doc = await res.json();
  const f = doc.fields || {};
  const want = ['releaseName', 'title', 'artistName', 'artistId', 'userId', 'submittedBy',
    'labelName', 'labelId', 'labelUserId', 'labelOwnerId',
    'createdBy', 'ownerId', 'partnerId', 'sellerId',
  ];
  for (const k of want) {
    const v = parseVal(f[k]);
    if (v !== null) console.log(`${k}: ${JSON.stringify(v)}`);
  }
  console.log('\nAll top-level fields:', Object.keys(f).join(', '));
  // Show first track's metadata to see if it carries its own artist
  const tracks = parseVal(f.tracks) || [];
  if (tracks.length) {
    const t = tracks[5] || tracks[0]; // index 5 = Twisted Assasin
    console.log('\nSample track [5]:');
    console.log('  trackName:', t.trackName);
    for (const k of ['artistName', 'artistId', 'userId', 'submittedBy', 'partnerId', 'splitAccount']) {
      if (t[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(t[k])}`);
    }
    console.log('  all keys:', Object.keys(t).join(', '));
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
