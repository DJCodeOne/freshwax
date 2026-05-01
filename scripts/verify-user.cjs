// Mark a Firebase Auth user as emailVerified=true (admin override).
// Also mirrors the change into the Firestore users doc so client-side
// `userDoc.emailVerified` checks match Auth.
//
// Usage: node scripts/verify-user.cjs <uid>
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

const uid = process.argv[2];
if (!uid) {
  console.error('usage: node scripts/verify-user.cjs <uid>');
  process.exit(1);
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Token error: ' + JSON.stringify(j));
  return j.access_token;
}

(async () => {
  const token = await getToken();

  // 1. Mark Firebase Auth user as verified.
  console.log(`Marking Firebase Auth uid=${uid} as emailVerified=true ...`);
  const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: uid, emailVerified: true }),
  });
  const authData = await authRes.json();
  if (!authRes.ok) {
    console.error('Auth update failed:', authRes.status, authData);
    process.exit(1);
  }
  console.log('  Auth ok:', JSON.stringify({ localId: authData.localId, email: authData.email, emailVerified: authData.emailVerified }));

  // 2. Mirror into the Firestore users doc.
  console.log(`Mirroring into Firestore users/${uid} ...`);
  const fsRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=emailVerified&updateMask.fieldPaths=updatedAt`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        emailVerified: { booleanValue: true },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  const fsData = await fsRes.json();
  if (!fsRes.ok) {
    console.error('Firestore update failed:', fsRes.status, fsData);
    process.exit(1);
  }
  console.log('  Firestore ok.');

  console.log('\nDone. User should hard-refresh; client-side checkEmailVerified will pick up the new state on next reload().');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
