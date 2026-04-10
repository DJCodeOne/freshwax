// Quick utility — list all slots currently marked status:'live' and let
// you end stale ones.
//
// Usage:
//   node scripts/check-live-slots.cjs                # list only
//   node scripts/check-live-slots.cjs --end <slotId> # mark slot as ended

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

const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function runQuery(token, body) {
  const r = await fetch(`${FB}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await r.json();
}

async function patchDoc(token, col, id, fields, mask) {
  const params = new URLSearchParams();
  for (const p of mask) params.append('updateMask.fieldPaths', p);
  const r = await fetch(`${FB}/${col}/${encodeURIComponent(id)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`patch ${col}/${id} ${r.status} ${await r.text()}`);
}

function s(v) { return v?.stringValue || ''; }

(async () => {
  const tok = await getToken();
  const args = process.argv.slice(2);
  const endIdx = args.indexOf('--end');

  if (endIdx >= 0) {
    const slotId = args[endIdx + 1];
    if (!slotId) { console.error('Need slot ID after --end'); process.exit(1); }
    console.log(`Ending slot ${slotId}...`);
    await patchDoc(tok, 'livestreamSlots', slotId, {
      status: { stringValue: 'ended' },
      endedAt: { stringValue: new Date().toISOString() },
    }, ['status', 'endedAt']);
    console.log('  ✓ Done');
    return;
  }

  // List all live slots via runQuery
  const result = await runQuery(tok, {
    structuredQuery: {
      from: [{ collectionId: 'livestreamSlots' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'live' } } },
      limit: 20,
    },
  });

  const docs = (result || []).filter((r) => r.document).map((r) => ({
    id: r.document.name.split('/').pop(),
    fields: r.document.fields || {},
  }));

  console.log(`Slots with status='live':  ${docs.length}\n`);
  const now = new Date();
  for (const d of docs) {
    const f = d.fields;
    const djName = s(f.djName);
    const djId = s(f.djId);
    const start = s(f.startTime);
    const end = s(f.endTime);
    const expired = end && new Date(end) < now;
    const flag = expired ? '⚠️ STALE' : '✓ active';
    console.log(`  ${flag}  ${d.id}`);
    console.log(`           DJ: ${djName} (${djId})`);
    console.log(`           ${start}  →  ${end}`);
  }

  if (docs.some((d) => s(d.fields.endTime) && new Date(s(d.fields.endTime)) < now)) {
    console.log('\nTo end a stale slot:');
    console.log('  node scripts/check-live-slots.cjs --end <slotId>');
  }
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
