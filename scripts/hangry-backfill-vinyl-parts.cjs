// scripts/hangry-backfill-vinyl-parts.cjs
// Adds vinylParts array to Hangry Vol.1 + Vol.2 release docs.
//
// vinylParts is the new per-part schema for multi-record vinyl releases.
// Each entry: { name, price, stock, trackNumbers, pressed }
// - trackNumbers references displayTrackNumber on release.tracks
// - pressed=false means stock=0 and the storefront should show "coming soon"
//
// Stock defaults to 200 (Hangry's typical first run) — they can adjust via
// the pro dashboard part editor (Phase B work). Vol.2 Part 2 starts at 0
// since it hasn't been pressed yet.
//
// After Firestore PATCH, calls the admin sync-release-to-d1 endpoint to
// mirror the change into D1 + bust caches in one go.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'freshwax-store';

const PARTS = {
  'hangry_records_FW-1780739181417': [
    {
      name: 'Part 1', price: 15, stock: 200, pressed: true,
      trackTitles: ['Abstract Drumz - Higher', 'MAC V - Panopticon', 'Polarity - Final Heaven', 'Sargy - Ultimate Reality'],
    },
    {
      name: 'Part 2', price: 15, stock: 200, pressed: true,
      trackTitles: ['16AJ - FadeAway', 'Illicit - Departures', 'Mom$ - Vogued', 'SuM - Time Wound'],
    },
  ],
  'hangry_records_FW-1780824861889': [
    {
      name: 'Part 1', price: 15, stock: 200, pressed: true,
      trackTitles: ['Antares - Ki', 'Ed.Asher - Force Field', 'D.K.Ritual - War In The Holy Land', 'Duburban - Meet His Majesty'],
    },
    {
      name: 'Part 2', price: 15, stock: 0, pressed: false,
      trackTitles: ['Jamin Nimjah - Yout Dem', 'Murder Most Foul - Eases Him In', 'REZ - War Cry', 'Tazz - Nu Style Drumglist'],
    },
  ],
};

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const vars = {};
  content.split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim();
  });
  return vars;
}

async function getAccessToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const signInput = h + '.' + p;
  let pem = privateKeyPem;
  if (pem.startsWith('"') && pem.endsWith('"')) pem = pem.slice(1, -1);
  pem = pem.replace(/\\n/g, '\n');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signInput), pem).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + signInput + '.' + sig,
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

function buildVinylPartsFirestoreValue(parts) {
  return {
    arrayValue: {
      values: parts.map(p => ({
        mapValue: {
          fields: {
            name: { stringValue: p.name },
            price: { integerValue: String(p.price) },
            stock: { integerValue: String(p.stock) },
            pressed: { booleanValue: p.pressed },
            trackNumbers: {
              arrayValue: {
                values: p.trackNumbers.map(n => ({ integerValue: String(n) })),
              },
            },
          },
        },
      })),
    },
  };
}

(async () => {
  const env = loadEnv();
  const token = await getAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

  for (const [releaseId, partsConfig] of Object.entries(PARTS)) {
    console.log(`\n=== ${releaseId} ===`);
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${releaseId}`);
    const doc = await r.json();
    const tracks = (doc.fields?.tracks?.arrayValue?.values || []).map((t, i) => {
      const f = t.mapValue?.fields || {};
      return {
        num: parseInt(f.displayTrackNumber?.integerValue || f.trackNumber?.integerValue || (i + 1)),
        title: f.trackName?.stringValue || '',
      };
    });

    const partsWithNumbers = partsConfig.map(p => {
      const trackNumbers = p.trackTitles.map(title => {
        const match = tracks.find(t => t.title === title);
        if (!match) {
          console.error(`  ! NO MATCH for "${title}" in tracks: ${tracks.map(t => t.title).join(' | ')}`);
          return null;
        }
        return match.num;
      }).filter(Boolean);
      return { name: p.name, price: p.price, stock: p.stock, pressed: p.pressed, trackNumbers };
    });

    for (const p of partsWithNumbers) {
      console.log(`  ${p.name}: tracks ${p.trackNumbers.join(', ')} (£${p.price}, stock ${p.stock}, pressed=${p.pressed})`);
    }

    const patchUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/releases/${releaseId}?updateMask.fieldPaths=vinylParts`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { vinylParts: buildVinylPartsFirestoreValue(partsWithNumbers) } }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error(`  PATCH failed:`, patchRes.status, err);
      continue;
    }
    console.log(`  PATCHed Firestore`);

    // D1 sync via admin endpoint (avoids needing wrangler auth)
    const adminKey = env.ADMIN_KEY || env.ADMIN_SECRET;
    if (adminKey) {
      const syncRes = await fetch(`https://freshwax.co.uk/api/admin/sync-release-to-d1/?releaseId=${releaseId}&confirm=yes`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const syncJson = await syncRes.json();
      console.log(`  D1 sync:`, syncJson.message || syncJson);
    } else {
      console.warn(`  No ADMIN_KEY — skip D1 sync`);
    }
  }
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
