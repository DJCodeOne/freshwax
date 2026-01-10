// Firebase Data Backup Script
// Downloads key Firestore collections to local JSON files
// Uses service account for protected collections

require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  'newsletter-subscribers'
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

function fetchCollection(collection, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?pageSize=1000`,
      method: 'GET',
      headers: accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}
    };

    if (!accessToken) {
      options.path += `&key=${API_KEY}`;
    }

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            console.log(`  ⚠ ${collection}: ${json.error.message}`);
            resolve({ collection, documents: [], error: json.error.message });
          } else {
            const docs = json.documents || [];
            console.log(`  ✓ ${collection}: ${docs.length} documents`);
            resolve({ collection, documents: docs });
          }
        } catch (e) {
          console.log(`  ✗ ${collection}: Parse error`);
          resolve({ collection, documents: [], error: e.message });
        }
      });
    }).on('error', (e) => {
      console.log(`  ✗ ${collection}: ${e.message}`);
      resolve({ collection, documents: [], error: e.message });
    });
  });
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

  console.log('Fetching collections...');

  const allData = {};
  let totalDocs = 0;

  for (const collection of COLLECTIONS) {
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
