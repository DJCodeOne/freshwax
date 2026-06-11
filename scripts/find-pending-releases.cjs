// List all releases with status 'pending' (admin pending-releases queue)
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
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

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

(async () => {
  const tok = await getToken();
  const q = { structuredQuery: { from: [{ collectionId: 'releases' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } }, limit: 50 } };
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const d = await r.json();
  let n = 0;
  for (const it of d) {
    if (!it.document) continue;
    n++;
    const f = it.document.fields;
    console.log(JSON.stringify({
      id: it.document.name.split('/').pop(),
      releaseName: f.releaseName?.stringValue || f.title?.stringValue || '?',
      artist: f.artistName?.stringValue || '?',
      label: f.labelName?.stringValue || f.label?.stringValue || '?',
      status: f.status?.stringValue,
      published: f.published?.booleanValue,
      approved: f.approved?.booleanValue,
      createdAt: f.createdAt?.stringValue || f.createdAt?.timestampValue,
      processedAt: f.processedAt?.stringValue || f.processedAt?.timestampValue,
      uploadedAt: f.uploadedAt?.stringValue || f.uploadedAt?.timestampValue,
      approvedAt: f.approvedAt?.stringValue,
      submitterEmail: f.submitterEmail?.stringValue,
      trackCount: f.tracks?.arrayValue?.values?.length ?? 0,
    }, null, 2));
  }
  if (!n) console.log('No pending releases found');
})().catch(e => console.error('Err:', e.message));
