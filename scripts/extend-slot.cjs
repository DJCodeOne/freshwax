// One-off: extend a live slot's endTime to keep the broadcast going past
// the hour. Same effect as the new auto-extend logic in get-actions.ts;
// useful as a manual override before that deploy goes live or for support.
//
// Usage: node scripts/extend-slot.cjs <slotId> [hours=2]
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
const SLOT_ID = process.argv[2];
const HOURS = parseFloat(process.argv[3] || '2');
if (!SLOT_ID) { console.error('usage: node scripts/extend-slot.cjs <slotId> [hours=2]'); process.exit(1); }
function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  const newEnd = new Date(Date.now() + HOURS * 60 * 60 * 1000);
  newEnd.setMinutes(0, 0, 0);
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/livestreamSlots/${SLOT_ID}?updateMask.fieldPaths=endTime&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=extended&updateMask.fieldPaths=lastExtendedAt`;
  const w = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      endTime: { timestampValue: newEnd.toISOString() },
      updatedAt: { timestampValue: new Date().toISOString() },
      extended: { booleanValue: true },
      lastExtendedAt: { timestampValue: new Date().toISOString() },
    } }),
  });
  if (!w.ok) { console.error('patch failed:', w.status, await w.text()); process.exit(1); }
  console.log(`Slot ${SLOT_ID} endTime extended to ${newEnd.toISOString()}`);
})().catch(e => { console.error(e); process.exit(1); });
