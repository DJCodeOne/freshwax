// One-off: find users matching "oren" by display name or email + check verification status.
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
const API_KEY = process.env.FIREBASE_API_KEY;

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}

function parseVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue) {
    const obj = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = parseVal(val);
    return obj;
  }
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseVal);
  return null;
}

(async () => {
  const token = await getToken();
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

  // Query users where displayName contains "oren" — Firestore doesn't have CONTAINS,
  // so we list and filter client-side. List most-recently-created.
  const q = {
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      limit: 200,
    },
  };
  const res = await fetch(FB, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(q),
  });
  const arr = await res.json();
  if (!Array.isArray(arr)) {
    console.log('Bad response:', JSON.stringify(arr).slice(0, 400));
    process.exit(1);
  }

  const matches = [];
  for (const row of arr) {
    if (!row.document) continue;
    const fields = row.document.fields || {};
    const dn = (parseVal(fields.displayName) || '').toLowerCase();
    const em = (parseVal(fields.email) || '').toLowerCase();
    const fn = (parseVal(fields.firstName) || '').toLowerCase();
    if (dn.includes('oren') || em.includes('oren') || fn.includes('oren')) {
      const id = row.document.name.split('/').pop();
      matches.push({
        uid: id,
        displayName: parseVal(fields.displayName),
        email: parseVal(fields.email),
        emailVerified: parseVal(fields.emailVerified),
        provider: parseVal(fields.provider),
        createdAt: parseVal(fields.createdAt),
        roles: parseVal(fields.roles),
      });
    }
  }

  console.log(`Scanned ${arr.length} most-recent users, found ${matches.length} match(es) for "oren":\n`);
  for (const m of matches) console.log(JSON.stringify(m, null, 2));

  // Also check Firebase Auth (Identity Toolkit) for emailVerified flag — the
  // users doc field can be stale; Auth is authoritative.
  if (matches.length && API_KEY) {
    console.log('\n--- Firebase Auth records (authoritative emailVerified) ---');
    const lookup = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:lookup?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: matches.map((m) => m.uid) }),
    });
    const lookupData = await lookup.json();
    for (const u of (lookupData.users || [])) {
      console.log(JSON.stringify({
        uid: u.localId,
        email: u.email,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt ? new Date(parseInt(u.createdAt)).toISOString() : null,
        lastLogin: u.lastLoginAt ? new Date(parseInt(u.lastLoginAt)).toISOString() : null,
        providerIds: (u.providerUserInfo || []).map((p) => p.providerId),
      }, null, 2));
    }
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
