require('dotenv').config();
const https = require('https');
const crypto = require('crypto');

const PROJECT_ID = 'freshwax-store';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': postData.length }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).access_token));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function createDocument(collection, docId, fields, accessToken) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ fields });
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?documentId=${docId}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`  ✓ Created users/${docId}`);
          resolve(true);
        } else {
          const json = data ? JSON.parse(data) : {};
          console.log(`  ✗ Failed users/${docId}: ${json.error?.message || res.statusCode}`);
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      console.log(`  ✗ Error: ${e.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== Adding Missing Users ===\n');

  const accessToken = await getAccessToken();
  console.log('✓ Authenticated\n');

  // 1. freshwaxonline@gmail.com - original admin account
  console.log('Adding freshwaxonline@gmail.com (original admin):');
  await createDocument('users', 'Y3TGc171cHSWTqZDRSniyu7Jxc33', {
    uid: { stringValue: 'Y3TGc171cHSWTqZDRSniyu7Jxc33' },
    email: { stringValue: 'freshwaxonline@gmail.com' },
    displayName: { stringValue: 'Fresh Wax Admin' },
    displayNameLower: { stringValue: 'fresh wax admin' },
    name: { stringValue: 'David Hagon' },
    phone: { stringValue: '+447971331814' },
    provider: { stringValue: 'email' },
    emailVerified: { booleanValue: true },
    createdAt: { timestampValue: '2025-12-11T00:00:00.000Z' },
    updatedAt: { timestampValue: new Date().toISOString() },
    roles: {
      mapValue: {
        fields: {
          customer: { booleanValue: true },
          admin: { booleanValue: true },
          djEligible: { booleanValue: true },
          artist: { booleanValue: false },
          merchSeller: { booleanValue: false },
          vinylSeller: { booleanValue: false }
        }
      }
    }
  }, accessToken);

  // 2. Bob Fresh - test DJ account (suspended)
  console.log('\nAdding Bob Fresh (test DJ account - suspended):');
  await createDocument('users', 'syAaEemyYhc1WjS0zwSQFgpAhUz2', {
    uid: { stringValue: 'syAaEemyYhc1WjS0zwSQFgpAhUz2' },
    email: { stringValue: 'david@chilterncomputers.net' },
    displayName: { stringValue: 'Bob Fresh' },
    displayNameLower: { stringValue: 'bob fresh' },
    name: { stringValue: 'Bob Fresh' },
    phone: { stringValue: '07971331814' },
    provider: { stringValue: 'email' },
    emailVerified: { booleanValue: true },
    createdAt: { timestampValue: '2025-12-11T17:54:51.795Z' },
    updatedAt: { timestampValue: new Date().toISOString() },
    suspended: { booleanValue: true },
    deleted: { booleanValue: true },
    deletedAt: { stringValue: '2025-12-29T18:49:20.720Z' },
    roles: {
      mapValue: {
        fields: {
          customer: { booleanValue: true },
          admin: { booleanValue: false },
          djEligible: { booleanValue: true },
          artist: { booleanValue: true },
          merchSeller: { booleanValue: true },
          vinylSeller: { booleanValue: false }
        }
      }
    }
  }, accessToken);

  console.log('\n=== Done ===');
}

main().catch(console.error);
