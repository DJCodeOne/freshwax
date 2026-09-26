// Firebase Data Backup Script
// Downloads key Firestore collections to local JSON files
// Uses service account for protected collections

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load .env from the repo root with Node's native loader — works from any cwd
// and has no dependency that can vanish from node_modules (dotenv did, Feb 2026).
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (e) {
  console.log(`Warning: could not load .env: ${e.message}`);
}

const API_KEY = process.env.FIREBASE_API_KEY || process.env.PUBLIC_FIREBASE_API_KEY;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const COLLECTIONS = [
  'customers',
  'users',
  'orders',
  'releases',
  'artists',
  'merch',
  'merch-suppliers',
  'dj-mixes',
  'vinyl-listings',
  'vinyl-orders',
  'livestreamSlots',
  'system',
  'giftCards',
  'blog',
  'role-requests',
  'newsletter-subscribers',
  'subscribers',
  'admins'
];

// Generate JWT for service account auth
function createJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${encHeader}.${encPayload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(PRIVATE_KEY, 'base64url');

  return `${signatureInput}.${signature}`;
}

// Get access token from service account
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const jwt = createJWT();
    const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.access_token);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// One page of a collection listing. Firestore caps pageSize at 300 and returns
// nextPageToken for the rest.
function fetchCollectionPage(collection, accessToken, pageToken) {
  return new Promise((resolve) => {
    let path = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?pageSize=300`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    if (!accessToken) path += `&key=${API_KEY}`;
    const options = {
      hostname: 'firestore.googleapis.com',
      path,
      method: 'GET',
      headers: accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) resolve({ error: json.error.message });
          else resolve({ documents: json.documents || [], nextPageToken: json.nextPageToken || null });
        } catch (e) {
          resolve({ error: `Parse error: ${e.message}` });
        }
      });
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

// Every top-level collection in the database (documents:listCollectionIds).
// The hand-written COLLECTIONS list drifted: by Sep 2026 it missed 29 of 42
// collections (salesLedger, payouts, pendingPayouts, treasury, consentLogs,
// vinylListings, …) and named two that don't exist (vinyl-listings, blog).
function listCollectionIds(accessToken) {
  const fetchPage = (pageToken) => new Promise((resolve) => {
    const body = JSON.stringify(pageToken ? { pageSize: 300, pageToken } : { pageSize: 300 });
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents:listCollectionIds`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: { message: e.message } }); }
      });
    });
    req.on('error', (e) => resolve({ error: { message: e.message } }));
    req.write(body);
    req.end();
  });
  return (async () => {
    const ids = [];
    let pageToken = null;
    do {
      const page = await fetchPage(pageToken);
      if (page.error) throw new Error(page.error.message || 'listCollectionIds failed');
      ids.push(...(page.collectionIds || []));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    return ids;
  })();
}

// Every document in a collection, following nextPageToken. (Until Sep 2026 this
// read ONE page, so every collection over 300 documents was backed up only in
// part — e.g. livestreamSlots stopped at April 2026.)
async function fetchCollection(collection, accessToken) {
  const documents = [];
  let pageToken = null;
  let pages = 0;
  do {
    const page = await fetchCollectionPage(collection, accessToken, pageToken);
    if (page.error) {
      console.log(`  ⚠ ${collection}: ${page.error}${documents.length ? ` (after ${documents.length} documents)` : ''}`);
      return { collection, documents, error: page.error };
    }
    documents.push(...page.documents);
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken && pages < 1000);
  console.log(`  ✓ ${collection}: ${documents.length} documents`);
  return { collection, documents };
}

// Convert Firestore format to plain JSON
function simplifyDocument(doc) {
  if (!doc || !doc.fields) return null;

  const id = doc.name ? doc.name.split('/').pop() : 'unknown';
  const result = { _id: id };

  function simplifyValue(value) {
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.integerValue !== undefined) return parseInt(value.integerValue);
    if (value.doubleValue !== undefined) return value.doubleValue;
    if (value.booleanValue !== undefined) return value.booleanValue;
    if (value.timestampValue !== undefined) return value.timestampValue;
    if (value.nullValue !== undefined) return null;
    if (value.arrayValue) {
      return (value.arrayValue.values || []).map(simplifyValue);
    }
    if (value.mapValue) {
      const obj = {};
      for (const [k, v] of Object.entries(value.mapValue.fields || {})) {
        obj[k] = simplifyValue(v);
      }
      return obj;
    }
    return value;
  }

  for (const [key, value] of Object.entries(doc.fields)) {
    result[key] = simplifyValue(value);
  }

  return result;
}

async function main() {
  const timestamp = new Date().toISOString().slice(0, 10);

  console.log('=== Firebase Data Backup ===');
  console.log(`Date: ${timestamp}`);
  console.log('');

  // Get service account access token
  let accessToken = null;
  if (CLIENT_EMAIL && PRIVATE_KEY) {
    console.log('Authenticating with service account...');
    try {
      accessToken = await getAccessToken();
      console.log('✓ Authenticated');
    } catch (e) {
      console.log('⚠ Service account auth failed, using API key');
    }
  } else {
    console.log('⚠ No service account configured, using API key');
  }
  console.log('');

  // Create backup directories
  const backupDirs = [
    `E:\\FreshWax-Backups\\firebase-data`,
    `F:\\FreshWax-Backups\\firebase-data`
  ];

  for (const dir of backupDirs) {
    if (fs.existsSync(path.dirname(dir))) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // Back up EVERY collection; the static list is only the fallback when
  // discovery fails (e.g. API-key mode, which can't list collections).
  let collections = COLLECTIONS;
  if (accessToken) {
    try {
      const discovered = await listCollectionIds(accessToken);
      if (discovered.length) {
        collections = [...new Set([...COLLECTIONS.filter(c => discovered.includes(c)), ...discovered.sort()])];
        console.log(`Discovered ${discovered.length} collections`);
      }
    } catch (e) {
      console.log(`⚠ Could not list collections (${e.message}); using the static list`);
    }
  }

  console.log('Fetching collections...');

  const allData = {};
  let totalDocs = 0;

  for (const collection of collections) {
    const result = await fetchCollection(collection, accessToken);
    const simplified = result.documents.map(simplifyDocument).filter(Boolean);
    allData[collection] = simplified;
    totalDocs += simplified.length;
  }

  console.log('');
  console.log(`Total: ${totalDocs} documents`);

  // Save to backup locations
  const filename = `firebase-backup-${timestamp}.json`;

  for (const dir of backupDirs) {
    if (fs.existsSync(dir)) {
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, JSON.stringify(allData, null, 2));
      console.log(`Saved: ${filepath}`);

      // Also save a "latest" copy for easy access
      const latestPath = path.join(dir, 'firebase-backup-latest.json');
      fs.writeFileSync(latestPath, JSON.stringify(allData, null, 2));
    }
  }

  // Calculate file size
  const samplePath = path.join(backupDirs[0], filename);
  if (fs.existsSync(samplePath)) {
    const stats = fs.statSync(samplePath);
    console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }

  console.log('');
  console.log('=== Backup Complete ===');
}

main().catch(console.error);
