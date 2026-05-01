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
function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function parseVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue) { const o = {}; for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = parseVal(val); return o; }
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseVal);
  return null;
}
(async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const token = (await tr.json()).access_token;

  // Look up Oren's order to see exact release IDs in items
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/orders/SwRRRkCavbWH4zlLuRsL', { headers: { Authorization: 'Bearer ' + token } });
  const ord = await r.json();
  const items = parseVal({ mapValue: { fields: ord.fields } }).items || [];
  console.log('Oren\'s order items:');
  for (const it of items) console.log('  releaseId=' + (it.releaseId || it.id) + ' productId=' + (it.productId || '-') + ' title=' + (it.title || it.name));

  // For each item, look up the release doc
  for (const it of items) {
    const releaseId = it.releaseId || it.productId || it.id;
    if (!releaseId) continue;
    const rr = await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/releases/' + releaseId, { headers: { Authorization: 'Bearer ' + token } });
    if (!rr.ok) { console.log('  release ' + releaseId + ' not found'); continue; }
    const rj = await rr.json();
    const rdoc = Object.fromEntries(Object.entries(rj.fields || {}).map(([k, v]) => [k, parseVal(v)]));
    console.log('\nrelease/' + releaseId + ':');
    console.log('  title:', rdoc.title);
    console.log('  artistId:', rdoc.artistId);
    console.log('  userId:', rdoc.userId);
    console.log('  submittedBy:', rdoc.submittedBy);
    console.log('  submitterId:', rdoc.submitterId);
    console.log('  uploadedBy:', rdoc.uploadedBy);
    console.log('  payoutSplits:', JSON.stringify(rdoc.payoutSplits));
  }

  // Also look up which releases Bakkus owns (by any of the 4 fields)
  const FB = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents:runQuery';
  const allReleases = await (await fetch(FB, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'releases' }], limit: 500 } }) })).json();
  const releases = allReleases.filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
  console.log('\n\nReleases by ownership field:');
  const ARTISTS = [
    ['8WmxYeCp4PSym5iWHahgizokn5F2', 'Code One'],
    ['CCMDrCWRkUXiPN7O83iSfm1BxGo1', 'Bakkus'],
    ['OcnffhxjgTVvKkIDIG8zjujTOiY2', 'UL'],
  ];
  for (const [aid, an] of ARTISTS) {
    const owned = releases.filter(r => r.artistId === aid || r.userId === aid || r.submittedBy === aid);
    console.log('  ' + an + ' (' + aid.slice(-6) + '):');
    for (const r of owned) console.log('    - ' + r.id + ' "' + r.title + '" artistId=' + r.artistId + ' userId=' + (r.userId || '-') + ' submittedBy=' + (r.submittedBy || '-'));
  }
})().catch(e => { console.error(e); process.exit(1); });
