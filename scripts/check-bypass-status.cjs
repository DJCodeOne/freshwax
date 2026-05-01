const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
for (const raw of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('='); if (eq < 0) continue;
  const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const UID = process.argv[2] || 'DCqfp6pfFhh7XOcSQ4P5xPmmUBg1';
function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function parseVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue) { const o = {}; for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = parseVal(val); return o; }
  return null;
}
(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  console.log('--- users/' + UID + ' bypass flags ---');
  const r1 = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${UID}`, { headers: { Authorization: 'Bearer ' + token } });
  const f1 = (await r1.json()).fields || {};
  for (const k of ['go-liveBypassed', 'bypassedAt', 'bypassedBy', 'isApproved', 'approved']) console.log(`  ${k}:`, parseVal(f1[k]));

  console.log('\n--- djLobbyBypass/' + UID + ' ---');
  const r2 = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/djLobbyBypass/${UID}`, { headers: { Authorization: 'Bearer ' + token } });
  if (r2.ok) {
    const f2 = (await r2.json()).fields || {};
    for (const k of ['email', 'name', 'reason', 'grantedAt', 'grantedBy']) console.log(`  ${k}:`, parseVal(f2[k]));
  } else {
    console.log('  (no doc — bypass not granted)');
  }
})().catch((e) => { console.error(e); process.exit(1); });
