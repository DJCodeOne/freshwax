// Find a user across users + artists + Firebase Auth and force-verify
// their email if needed. Mirror of how oren was handled previously.
//
// Usage:  node scripts/find-and-verify-user.cjs <searchTerm> [--apply]
//   searchTerm matches against email substring or artistName/displayName/name
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

const SEARCH = (process.argv[2] || '').toLowerCase();
const APPLY = process.argv.includes('--apply');
if (!SEARCH) {
  console.error('Usage: node scripts/find-and-verify-user.cjs <searchTerm> [--apply]');
  process.exit(1);
}

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
  // Mint two tokens: Firestore (datastore) + Identity Toolkit (auth admin)
  function jwtFor(scope) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return head + '.' + body + '.' + sig;
  }
  async function getToken(scope) {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwtFor(scope),
      }),
    });
    return (await tr.json()).access_token;
  }
  const fsToken = await getToken('https://www.googleapis.com/auth/datastore');
  const authToken = await getToken('https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase');

  // Pull users + artists, filter on the search term
  async function listCol(col) {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + fsToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], limit: 500 } }),
    });
    return (await r.json()).filter(x => x.document).map(x => Object.assign({ id: x.document.name.split('/').pop() }, Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, parseVal(v)]))));
  }
  const [users, artists] = await Promise.all([listCol('users'), listCol('artists')]);

  function match(d) {
    const fields = [d.email, d.artistName, d.displayName, d.name, d.brandName, d.id].filter(Boolean).map(String).map(s => s.toLowerCase());
    return fields.some(f => f.includes(SEARCH));
  }
  const userMatches = users.filter(match);
  const artistMatches = artists.filter(match);

  console.log(`Search "${SEARCH}":`);
  console.log(`  ${userMatches.length} users, ${artistMatches.length} artists\n`);

  const candidates = new Map();
  for (const u of userMatches) {
    candidates.set(u.id, { uid: u.id, email: u.email, displayName: u.displayName || u.name, source: 'users', user: u });
  }
  for (const a of artistMatches) {
    if (!candidates.has(a.id)) candidates.set(a.id, { uid: a.id, email: a.email, displayName: a.artistName || a.displayName || a.name, source: 'artists' });
    Object.assign(candidates.get(a.id), { artist: a });
  }

  if (candidates.size === 0) { console.log('No matches.'); return; }

  for (const c of candidates.values()) {
    console.log(`──────────────────────────────────────────`);
    console.log(`${c.displayName || '(no name)'} <${c.email || '?'}>`);
    console.log(`  uid: ${c.uid}`);
    console.log(`  found in: ${c.source}${c.artist && c.user ? ' + artists' : ''}`);
    if (c.artist) {
      console.log(`  artist.approved:        ${c.artist.approved}`);
      console.log(`  artist.emailVerified:   ${c.artist.emailVerified}`);
      console.log(`  artist.suspended:       ${c.artist.suspended}`);
    }
    if (c.user) {
      console.log(`  user.emailVerified:     ${c.user.emailVerified}`);
      console.log(`  user.role:              ${c.user.role}`);
    }

    // Look up Firebase Auth state via Identity Toolkit
    try {
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:lookup`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: [c.uid] }),
      });
      const j = await r.json();
      const acct = (j.users || [])[0];
      if (!acct) {
        console.log('  Auth account: NOT FOUND');
        continue;
      }
      console.log(`  Auth.email:             ${acct.email}`);
      console.log(`  Auth.emailVerified:     ${acct.emailVerified}`);
      console.log(`  Auth.disabled:          ${!!acct.disabled}`);
      console.log(`  Auth.lastLoginAt:       ${acct.lastLoginAt ? new Date(parseInt(acct.lastLoginAt)).toISOString() : 'never'}`);
      console.log(`  Auth.createdAt:         ${acct.createdAt ? new Date(parseInt(acct.createdAt)).toISOString() : '?'}`);
      console.log(`  Providers:              ${(acct.providerUserInfo || []).map(p => p.providerId).join(', ')}`);

      const needsVerify = !acct.emailVerified;
      const fsArtistNeedsVerify = c.artist && c.artist.emailVerified === false;
      const fsUserNeedsVerify = c.user && c.user.emailVerified === false;
      if (!needsVerify && !fsArtistNeedsVerify && !fsUserNeedsVerify) {
        console.log('  ✓ Already fully verified everywhere — nothing to do.');
        continue;
      }

      console.log(`  → needs verification fix: Auth=${needsVerify} artists.emailVerified=${fsArtistNeedsVerify} users.emailVerified=${fsUserNeedsVerify}`);

      if (!APPLY) { console.log('  (dry-run; pass --apply to fix)'); continue; }

      // Patch Firebase Auth (emailVerified + disabled=false for safety)
      if (needsVerify) {
        const upd = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ localId: c.uid, emailVerified: true }),
        });
        const ur = await upd.json();
        if (ur.error) console.log('  ✗ Auth update failed:', ur.error);
        else console.log('  ✓ Firebase Auth.emailVerified set to true');
      }
      // Patch Firestore artists doc
      if (fsArtistNeedsVerify) {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artists/${c.uid}?updateMask.fieldPaths=emailVerified&updateMask.fieldPaths=updatedAt`;
        const w = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + fsToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { emailVerified: { booleanValue: true }, updatedAt: { timestampValue: new Date().toISOString() } } }),
        });
        if (!w.ok) console.log('  ✗ artists patch failed:', w.status, await w.text());
        else console.log('  ✓ artists.emailVerified patched');
      }
      // Patch Firestore users doc
      if (fsUserNeedsVerify) {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${c.uid}?updateMask.fieldPaths=emailVerified&updateMask.fieldPaths=updatedAt`;
        const w = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + fsToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { emailVerified: { booleanValue: true }, updatedAt: { timestampValue: new Date().toISOString() } } }),
        });
        if (!w.ok) console.log('  ✗ users patch failed:', w.status, await w.text());
        else console.log('  ✓ users.emailVerified patched');
      }
    } catch (e) {
      console.log('  Auth lookup failed:', e.message);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
