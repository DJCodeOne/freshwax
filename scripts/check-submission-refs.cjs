// Does any live release doc reference files under a given submission folder?
// Usage: node scripts/check-submission-refs.cjs <submissionFolder>
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
const folder = process.argv[2];
if (!folder) { console.error('Usage: node scripts/check-submission-refs.cjs <submissionFolder>'); process.exit(1); }

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
  const q = { structuredQuery: { from: [{ collectionId: 'releases' }], where: { fieldFilter: { field: { fieldPath: 'submissionId' }, op: 'EQUAL', value: { stringValue: folder } } }, limit: 5 } };
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const d = await r.json();
  let any = false;
  for (const it of d) {
    if (!it.document) continue;
    any = true;
    const id = it.document.name.split('/').pop();
    const json = JSON.stringify(it.document.fields);
    const hits = (json.match(new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    // submissionId itself accounts for 1 hit; more means file URLs point there
    console.log(`${id}: ${hits} occurrence(s) of "${folder}" in doc (1 = submissionId only, safe to delete folder)`);
  }
  if (!any) console.log('No release found with that submissionId');
})().catch(e => console.error('Err:', e.message));
