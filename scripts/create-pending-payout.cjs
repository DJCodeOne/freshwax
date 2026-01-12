// scripts/create-pending-payout.js
// Run with: node scripts/create-pending-payout.js
// Creates a pending payout record for Max (SRS order)

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
        if (parsed.access_token) {
          resolve(parsed.access_token);
        } else {
          reject(new Error('Failed to get token: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function createPendingPayout() {
  console.log('Getting access token...');
  const token = await getAccessToken();
  console.log('Got access token');

  const now = new Date().toISOString();
  const payoutId = 'payout_' + Date.now() + '_srs';

  const payoutDoc = {
    fields: {
      artistId: { stringValue: 'JueT7q9eKjQk4iFRg2tXa4ZP8642' },
      artistName: { stringValue: 'Dark Dusk' },
      artistEmail: { stringValue: 'undergroundlair.23@gmail.com' },
      orderId: { stringValue: 'order_1768158963_osoj60u4' },
      orderNumber: { stringValue: 'FW-260111-SRS001' },
      amount: { doubleValue: 1.62 },
      itemAmount: { doubleValue: 1.62 },
      currency: { stringValue: 'gbp' },
      status: { stringValue: 'pending' },
      payoutMethod: { nullValue: null },
      notes: { stringValue: 'SRS - When Worlds Collide EP (2 tracks @ £1.00)' },
      createdAt: { stringValue: now },
      updatedAt: { stringValue: now }
    }
  };

  const url = '/v1/projects/freshwax-store/databases/(default)/documents/pendingPayouts?documentId=' + payoutId;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        if (res.statusCode === 200) {
          console.log('Pending payout created successfully!');
          console.log('Payout ID:', payoutId);
          console.log('Amount: £1.62 for Dark Dusk');
        } else {
          console.log('Response:', data.substring(0, 500));
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(payoutDoc));
    req.end();
  });
}

createPendingPayout().catch(e => console.error('Error:', e.message));
