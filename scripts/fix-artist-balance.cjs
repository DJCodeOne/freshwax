// scripts/fix-artist-balance.cjs
// Fixes Max's pendingBalance to be a number instead of {increment: 1.62}

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Read .env file
const envContent = fs.readFileSync('.env', 'utf8');
const privateKeyMatch = envContent.match(/FIREBASE_PRIVATE_KEY="([^"]+)"/s);
const privateKey = privateKeyMatch[1].replace(/\\n/g, '\n');
const clientEmail = 'firebase-adminsdk-fbsvc@freshwax-store.iam.gserviceaccount.com';

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = unsigned + '.' + signature;

  return new Promise((resolve, reject) => {
    const postData = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.access_token) resolve(parsed.access_token);
        else reject(new Error('Failed: ' + data));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function fixBalance() {
  console.log('Getting access token...');
  const token = await getAccessToken();
  console.log('Got token, updating artist pendingBalance...');

  const updateData = {
    fields: {
      pendingBalance: { doubleValue: 1.62 },
      updatedAt: { stringValue: new Date().toISOString() }
    }
  };

  const url = '/v1/projects/freshwax-store/databases/(default)/documents/artists/JueT7q9eKjQk4iFRg2tXa4ZP8642?updateMask.fieldPaths=pendingBalance&updateMask.fieldPaths=updatedAt';

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: url,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Fixed! pendingBalance is now £1.62');
        } else {
          console.log('Status:', res.statusCode);
          console.log('Response:', data.substring(0, 300));
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(updateData));
    req.end();
  });
}

fixBalance().catch(e => console.error('Error:', e.message));
