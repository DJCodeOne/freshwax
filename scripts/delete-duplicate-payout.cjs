// scripts/delete-duplicate-payout.cjs
// Deletes the duplicate pending payout for the SRS order

const fs = require('fs');
const https = require('https');
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

async function deleteDuplicate() {
  console.log('Getting access token...');
  const token = await getAccessToken();

  // Delete the duplicate payout (keep the first one, delete the second)
  const duplicateId = 'payout_1768170317037_srs';
  const url = `/v1/projects/freshwax-store/databases/(default)/documents/pendingPayouts/${duplicateId}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: url,
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer ' + token
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Deleted duplicate payout:', duplicateId);
        } else {
          console.log('Status:', res.statusCode);
          console.log('Response:', data);
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.end();
  });
}

deleteDuplicate().catch(e => console.error('Error:', e.message));
