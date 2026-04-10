// Quick lookup utility — finds users/artists matching a name fragment
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

async function listAll(token, col) {
  const docs = []; let pt = null;
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}?pageSize=300${pt ? `&pageToken=${pt}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    for (const doc of d.documents || []) docs.push({ id: doc.name.split('/').pop(), fields: doc.fields || {} });
    pt = d.nextPageToken || null;
  } while (pt);
  return docs;
}

function s(v) { return v?.stringValue || ''; }
function b(v) { return v?.booleanValue === true; }

(async () => {
  const tok = await getToken();
  const search = process.argv.slice(2).map((x) => x.toLowerCase());
  if (search.length === 0) { console.log('Usage: node scripts/find-users.cjs <name1> [name2] ...'); process.exit(1); }

  for (const col of ['artists', 'users', 'djLobbyBypass']) {
    console.log(`\n=== ${col} ===`);
    const docs = await listAll(tok, col);
    for (const d of docs) {
      const f = d.fields;
      const haystack = [s(f.email), s(f.displayName), s(f.artistName), s(f.name), s(f.username)].join(' ').toLowerCase();
      if (search.some((q) => haystack.includes(q))) {
        const approved = b(f.approved) || s(f.status) === 'approved';
        const djEligible = f.roles?.mapValue?.fields?.djEligible?.booleanValue === true;
        const display = s(f.displayName) || s(f.artistName) || s(f.name) || '?';
        console.log(`  ${d.id} | name=${display} | email=${s(f.email)} | approved=${approved} | djEligible=${djEligible}`);
      }
    }
  }
})();
