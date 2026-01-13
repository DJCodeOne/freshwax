// Quick script to sync a Firebase Auth user to Firestore using service account
// Run: node scripts/sync-user.cjs

require('dotenv').config();
const crypto = require('crypto');
const https = require('https');

const uid = 'GoqKD92DXrcu4ykYDo96SSZ3ahI2';
const email = 'jeffreycpackard@gmail.com';
const displayName = 'Jeffrey Packard';

const projectId = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!clientEmail || !privateKey) {
  console.error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in .dev.vars');
  process.exit(1);
}

// Create JWT for service account auth
function createJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://firestore.googleapis.com/',
    iat: now,
    exp: now + 3600
  };

  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${base64Header}.${base64Payload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(privateKey, 'base64url');

  return `${signatureInput}.${signature}`;
}

async function createUser() {
  const jwt = createJWT();

  const userData = {
    fields: {
      email: { stringValue: email },
      displayName: { stringValue: displayName },
      fullName: { stringValue: displayName },
      roles: {
        mapValue: {
          fields: {
            customer: { booleanValue: true },
            dj: { booleanValue: true },
            artist: { booleanValue: false },
            merchSupplier: { booleanValue: false },
            vinylSeller: { booleanValue: false },
            admin: { booleanValue: false }
          }
        }
      },
      permissions: {
        mapValue: {
          fields: {
            canBuy: { booleanValue: true },
            canComment: { booleanValue: true },
            canRate: { booleanValue: true }
          }
        }
      },
      approved: { booleanValue: false },
      suspended: { booleanValue: false },
      createdAt: { timestampValue: new Date().toISOString() },
      registeredAt: { timestampValue: new Date().toISOString() },
      syncedFromAuth: { booleanValue: true }
    }
  };

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users?documentId=${uid}`;
  const postData = JSON.stringify(userData);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✓ User created successfully!');
          resolve(JSON.parse(data));
        } else {
          console.log('Status:', res.statusCode);
          console.log('Response:', data);
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

console.log('Creating user document for:', email);
console.log('UID:', uid);
console.log('Using service account:', clientEmail);

createUser()
  .then(() => console.log('Done!'))
  .catch(err => console.error('Failed:', err.message));
