// scripts/find-srs-order.cjs
// Finds the SRS order document ID in Firebase

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

async function findSrsOrder() {
  console.log('Getting access token...');
  const token = await getAccessToken();
  console.log('Got token, querying orders...');

  // Query orders with orderNumber containing SRS
  const query = {
    structuredQuery: {
      from: [{ collectionId: 'orders' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'orderNumber' },
          op: 'EQUAL',
          value: { stringValue: 'FW-260111-SRS001' }
        }
      },
      limit: 5
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/freshwax-store/databases/(default)/documents:runQuery',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const results = JSON.parse(data);
        console.log('\nQuery results:');
        for (const result of results) {
          if (result.document) {
            const docPath = result.document.name;
            const docId = docPath.split('/').pop();
            const fields = result.document.fields;
            console.log('Document ID:', docId);
            console.log('Order Number:', fields.orderNumber?.stringValue);
            console.log('Customer:', fields.customerName?.stringValue || fields.customer?.mapValue?.fields?.firstName?.stringValue);
            console.log('---');
          } else {
            console.log('No documents found');
          }
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(query));
    req.end();
  });
}

findSrsOrder().catch(e => console.error('Error:', e.message));
