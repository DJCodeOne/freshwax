require('dotenv').config();
const https = require('https');
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Test entries to delete
const CUSTOMERS_TO_DELETE = [
  '0JXUbTBaBzZ3wx6iOD7ufo3jpCf1', // dave (ffyug@hhui.com)
  'I6XvXNsZxbUtVn1LPNMxIlJbVCk1', // empty
  'realuser123',
  'test-user-123',
  'test123',
  'test_wishlist_user',
  'test_wishlist_user2',
  'test_wishlist_user3',
  'testfix123',
  'testfollow123',
  'testfollow456',
  'testuser123'
];

const USERS_TO_DELETE = [
  'testBypass123'
];

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

function deleteDocument(collection, docId, accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`,
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 204) {
          console.log(`  ✓ Deleted ${collection}/${docId}`);
          resolve(true);
        } else {
          const json = data ? JSON.parse(data) : {};
          console.log(`  ✗ Failed ${collection}/${docId}: ${json.error?.message || res.statusCode}`);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.log(`  ✗ Error ${collection}/${docId}: ${e.message}`);
      resolve(false);
    });
    req.end();
  });
}

async function main() {
  console.log('=== Deleting Test Entries ===\n');

  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    console.log('Error: Service account credentials not found in .env');
    return;
  }

  console.log('Authenticating...');
  const accessToken = await getAccessToken();
  console.log('✓ Authenticated\n');

  console.log('Deleting from customers collection:');
  for (const id of CUSTOMERS_TO_DELETE) {
    await deleteDocument('customers', id, accessToken);
  }

  console.log('\nDeleting from users collection:');
  for (const id of USERS_TO_DELETE) {
    await deleteDocument('users', id, accessToken);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
