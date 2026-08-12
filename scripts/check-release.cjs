// Check release submitter/artist fields to determine dashboard visibility
// Usage: node scripts/check-release.cjs <releaseId>
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
// Guard the key like the sibling scripts do — without it a machine with no
// .env fails on a bare "Cannot read properties of undefined" rather than
// saying which credential is missing.
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
if (!PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
  console.error('Missing FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL — check freshwax/.env');
  process.exit(1);
}

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}

function s(v) { return v?.stringValue || ''; }

(async () => {
  const id = process.argv[2] || 'elipse_draai_FW-1777226552867';
  const tok = await getToken();
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${id}`, { headers: { Authorization: `Bearer ${tok}` } });
  const d = await r.json();
  if (!d.fields) { console.log('No fields:', JSON.stringify(d).slice(0, 500)); return; }
  const f = d.fields;
  console.log(`=== ${id} ===`);
  console.log('title:           ', s(f.title));
  console.log('artistName:      ', s(f.artistName));
  console.log('artistId:        ', s(f.artistId));
  console.log('submitterId:     ', s(f.submitterId));
  console.log('submitterEmail:  ', s(f.submitterEmail));
  console.log('submitterName:   ', s(f.submitterName));
  console.log('uploadedBy:      ', s(f.uploadedBy));
  console.log('userId:          ', s(f.userId));
  console.log('labelId:         ', s(f.labelId));
  console.log('labelName:       ', s(f.labelName));
  console.log('label:           ', s(f.label));
  console.log('status:          ', s(f.status));
  console.log('published:       ', f.published?.booleanValue);
  console.log('approvedAt:      ', s(f.approvedAt));
  console.log('uploadedAt:      ', s(f.uploadedAt));
})().catch(e => console.error('Error:', e.message));
