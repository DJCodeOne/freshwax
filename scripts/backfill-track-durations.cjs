// Backfill empty `duration` fields on release tracks by ffprobe-reading
// the MP3 length from the R2 CDN. Patches Firestore (tracks array) and
// triggers the admin D1 sync + KV cache invalidation.
//
// Usage:
//   node scripts/backfill-track-durations.cjs                # dry-run
//   node scripts/backfill-track-durations.cjs --apply        # write
//   node scripts/backfill-track-durations.cjs --apply <id>   # one release only

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

// Resolve ffprobe for unattended/scheduled runs where it isn't on PATH.
// FFPROBE_PATH is in .env (loaded above); fall back to deriving it from
// FFMPEG_PATH, then to a bare `ffprobe` on PATH.
const FFPROBE = process.env.FFPROBE_PATH
  || (process.env.FFMPEG_PATH
      ? process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, (m) => (/\.exe$/i.test(m) ? 'ffprobe.exe' : 'ffprobe'))
      : null)
  || 'ffprobe';

const APPLY = process.argv.includes('--apply');
const SINGLE_ID = process.argv.slice(2).find(a => !a.startsWith('--')) || null;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getFirestoreToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}

function fv(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fv(x); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fv);
  return null;
}
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') { const fields = {}; for (const [k, val] of Object.entries(v)) fields[k] = toFirestoreValue(val); return { mapValue: { fields } }; }
  throw new Error('Unsupported: ' + typeof v);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function probeRemoteDuration(url) {
  // ffprobe can read from a URL directly without downloading the whole file.
  const r = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    url
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const secs = parseFloat((r.stdout || '').trim());
  return Number.isFinite(secs) ? secs : null;
}

async function listEmptyDurationReleases(tok) {
  const q = { structuredQuery: { from: [{ collectionId: 'releases' }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], limit: 100 } };
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const docs = await r.json();
  const out = [];
  for (const it of docs) {
    if (!it.document) continue;
    const id = it.document.name.split('/').pop();
    if (SINGLE_ID && id !== SINGLE_ID) continue;
    const f = it.document.fields || {};
    const tracks = fv(f.tracks) || [];
    if (tracks.length === 0) continue;
    const empty = tracks.filter(t => !t || !t.duration || t.duration === '' || t.duration === '0' || t.duration === '0:00').length;
    if (empty > 0) out.push({ id, name: fv(f.releaseName) || fv(f.title) || '?', tracks, emptyCount: empty });
  }
  return out;
}

async function patchRelease(tok, id, newTracks) {
  const updatedAt = new Date().toISOString();
  const payload = { fields: { tracks: toFirestoreValue(newTracks), updatedAt: { stringValue: updatedAt } } };
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${id}?updateMask.fieldPaths=tracks&updateMask.fieldPaths=updatedAt`;
  const r = await fetch(url, { method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`PATCH ${id} failed: ${r.status} ${await r.text()}`);
}

async function syncAndBust(id) {
  if (!ADMIN_KEY) { console.warn('  ADMIN_KEY missing — skip D1 sync + cache bust'); return; }
  const headers = { 'X-Admin-Key': ADMIN_KEY };
  try {
    const r = await fetch(`https://freshwax.co.uk/api/admin/sync-release-to-d1/?releaseId=${id}&confirm=yes`, { headers });
    console.log('  D1 sync:', r.ok ? 'ok' : `failed ${r.status}`);
  } catch (e) { console.warn('  D1 sync error:', e.message); }
  try {
    const r = await fetch('https://freshwax.co.uk/api/admin/invalidate-cache/?target=releases', { headers });
    console.log('  KV bust:', r.ok ? 'ok' : `failed ${r.status}`);
  } catch (e) { console.warn('  KV bust error:', e.message); }
}

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}` + (SINGLE_ID ? ` | release: ${SINGLE_ID}` : ''));
  const tok = await getFirestoreToken();
  const releases = await listEmptyDurationReleases(tok);
  if (releases.length === 0) { console.log('No releases need duration backfill.'); return; }
  console.log(`Found ${releases.length} release(s) with empty durations.\n`);

  let totalPatched = 0;
  for (const rel of releases) {
    console.log(`▶ ${rel.id}  —  ${rel.name}  (${rel.emptyCount}/${rel.tracks.length} empty)`);
    const newTracks = [];
    let anyPatched = false;
    for (let i = 0; i < rel.tracks.length; i++) {
      const t = { ...rel.tracks[i] };
      const needs = !t.duration || t.duration === '' || t.duration === '0' || t.duration === '0:00';
      const url = t.mp3Url || t.wavUrl || t.previewUrl;
      if (!needs) { newTracks.push(t); continue; }
      if (!url) {
        console.log(`    ${i + 1}. ${t.trackName || t.title || '?'}  →  no audio URL, skip`);
        newTracks.push(t); continue;
      }
      process.stdout.write(`    ${i + 1}. ${t.trackName || t.title || '?'}  …  `);
      const secs = probeRemoteDuration(url);
      if (secs == null) { console.log('ffprobe failed, skip'); newTracks.push(t); continue; }
      const dur = formatDuration(secs);
      console.log(`${dur}  (${secs.toFixed(1)}s)`);
      t.duration = dur;
      newTracks.push(t);
      anyPatched = true;
      totalPatched++;
    }
    if (APPLY && anyPatched) {
      try {
        await patchRelease(tok, rel.id, newTracks);
        console.log('  Firestore patched.');
        await syncAndBust(rel.id);
      } catch (e) { console.error('  PATCH error:', e.message); }
    }
    console.log('');
  }

  console.log(`Tracks measured: ${totalPatched}`);
  if (!APPLY) console.log('(dry-run — pass --apply to write Firestore + D1 + cache)');
})().catch(e => { console.error(e); process.exit(1); });
