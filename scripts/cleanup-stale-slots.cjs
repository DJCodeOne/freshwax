// Cleanup stale livestream slots — bookings left in status 'scheduled'/'in_lobby'
// whose endTime is fully in the past (the booked time passed without going live
// and they were never completed/cancelled). They don't display (the schedule
// filters startTime > now) but they bloat the collection and queries.
//
// Marks them status:'expired' (a terminal status no schedule query matches), so
// the user's genuinely-upcoming bookings (endTime in the future) are untouched.
//
// Usage:
//   node scripts/cleanup-stale-slots.cjs            # DRY RUN — list only
//   node scripts/cleanup-stale-slots.cjs --apply    # actually patch them

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
  const r = await fetch(`${FB}:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return await r.json();
}

async function patchDoc(token, id, fields, mask) {
  const params = new URLSearchParams();
  for (const p of mask) params.append('updateMask.fieldPaths', p);
  const r = await fetch(`${FB}/livestreamSlots/${encodeURIComponent(id)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`patch ${id} ${r.status} ${await r.text()}`);
}

const s = (v) => (v && (v.stringValue || v.timestampValue)) || '';

(async () => {
  const apply = process.argv.includes('--apply');
  const token = await getToken();
  const nowISO = new Date().toISOString();

  const stale = [];
  for (const status of ['scheduled', 'in_lobby']) {
    const result = await runQuery(token, {
      structuredQuery: {
        from: [{ collectionId: 'livestreamSlots' }],
        where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: status } } },
        limit: 500,
      },
    });
    for (const r of (result || [])) {
      if (!r.document) continue;
      const f = r.document.fields || {};
      const endTime = s(f.endTime);
      // Stale = the booked end time is fully in the past.
      if (endTime && endTime < nowISO) {
        stale.push({ id: r.document.name.split('/').pop(), status, startTime: s(f.startTime), endTime, djName: s(f.djName) });
      }
    }
  }

  stale.sort((a, b) => a.startTime.localeCompare(b.startTime));
  console.log(`Now: ${nowISO}`);
  console.log(`Stale slots (status scheduled/in_lobby with endTime in the past): ${stale.length}\n`);
  for (const x of stale) {
    console.log(`  ${x.status.padEnd(10)} ${x.startTime} -> ${x.endTime} | ${x.djName} | ${x.id}`);
  }

  if (!stale.length) { console.log('\nNothing to clean.'); return; }
  if (!apply) { console.log(`\nDRY RUN — re-run with --apply to mark these ${stale.length} as 'expired'.`); return; }

  console.log(`\nApplying: marking ${stale.length} slots as 'expired'...`);
  let ok = 0, fail = 0;
  for (const x of stale) {
    try {
      await patchDoc(token, x.id, { status: { stringValue: 'expired' }, expiredAt: { stringValue: nowISO } }, ['status', 'expiredAt']);
      ok++;
    } catch (e) { fail++; console.error(`  ✗ ${x.id}: ${e.message}`); }
  }
  console.log(`Done. expired: ${ok}, failed: ${fail}`);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
