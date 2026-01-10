// Check for field conflicts between users and customers collections
// Identifies where the same field has different values for the same user

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

function fetchCollection(collection, accessToken) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?pageSize=1000`,
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        resolve(json.documents || []);
      });
    }).on('error', reject);
  });
}

function getValue(fieldValue) {
  if (!fieldValue) return undefined;
  if (fieldValue.stringValue !== undefined) return fieldValue.stringValue;
  if (fieldValue.booleanValue !== undefined) return fieldValue.booleanValue;
  if (fieldValue.integerValue !== undefined) return parseInt(fieldValue.integerValue);
  if (fieldValue.timestampValue !== undefined) return fieldValue.timestampValue;
  if (fieldValue.mapValue) return JSON.stringify(fieldValue.mapValue);
  if (fieldValue.arrayValue) return JSON.stringify(fieldValue.arrayValue);
  return JSON.stringify(fieldValue);
}

async function main() {
  console.log('=== Field Conflict Analysis ===\n');

  const accessToken = await getAccessToken();

  const [usersDocs, customersDocs] = await Promise.all([
    fetchCollection('users', accessToken),
    fetchCollection('customers', accessToken)
  ]);

  // Build maps by UID
  const usersMap = {};
  const customersMap = {};

  for (const doc of usersDocs) {
    const uid = doc.name.split('/').pop();
    usersMap[uid] = doc.fields || {};
  }

  for (const doc of customersDocs) {
    const uid = doc.name.split('/').pop();
    customersMap[uid] = doc.fields || {};
  }

  // Shared fields to check for conflicts
  const sharedFields = [
    'email', 'displayName', 'displayNameLower', 'name', 'phone',
    'suspended', 'approved', 'deleted', 'deletedAt',
    'isAdmin', 'isArtist', 'updatedAt'
  ];

  console.log('Checking for conflicts in shared fields...\n');

  let conflictCount = 0;
  const conflicts = [];

  for (const uid of Object.keys(usersMap)) {
    const userDoc = usersMap[uid];
    const customerDoc = customersMap[uid];

    if (!customerDoc) {
      continue; // User exists only in users collection
    }

    for (const field of sharedFields) {
      const userValue = getValue(userDoc[field]);
      const customerValue = getValue(customerDoc[field]);

      // Skip if both undefined or empty
      if (userValue === undefined && customerValue === undefined) continue;
      if (userValue === '' && customerValue === '') continue;
      if (userValue === undefined && customerValue === '') continue;
      if (userValue === '' && customerValue === undefined) continue;

      // Check for actual conflict
      if (userValue !== customerValue && userValue !== undefined && customerValue !== undefined) {
        conflictCount++;
        const email = getValue(userDoc.email) || getValue(customerDoc.email) || uid;
        conflicts.push({
          user: email,
          field,
          usersValue: userValue,
          customersValue: customerValue
        });
      }
    }
  }

  if (conflicts.length === 0) {
    console.log('✓ No conflicts found in shared fields!\n');
  } else {
    console.log(`⚠ Found ${conflictCount} conflicts:\n`);
    console.log('User | Field | Users Value | Customers Value');
    console.log('-----|-------|-------------|----------------');
    for (const c of conflicts) {
      console.log(`${c.user.substring(0, 30)} | ${c.field} | ${String(c.usersValue).substring(0, 30)} | ${String(c.customersValue).substring(0, 30)}`);
    }
  }

  // Check for users in customers but not in users
  console.log('\n=== Coverage Check ===');
  const usersUIDs = new Set(Object.keys(usersMap));
  const customersUIDs = new Set(Object.keys(customersMap));

  const onlyInUsers = [...usersUIDs].filter(uid => !customersUIDs.has(uid));
  const onlyInCustomers = [...customersUIDs].filter(uid => !usersUIDs.has(uid));

  console.log(`Users in both: ${[...usersUIDs].filter(uid => customersUIDs.has(uid)).length}`);
  console.log(`Only in users: ${onlyInUsers.length}`);
  console.log(`Only in customers: ${onlyInCustomers.length}`);

  if (onlyInCustomers.length > 0) {
    console.log('\nCustomers without users document:');
    for (const uid of onlyInCustomers) {
      const email = getValue(customersMap[uid].email) || 'no email';
      console.log(`  - ${uid} (${email})`);
    }
  }

  // Summary of what needs to be migrated
  console.log('\n=== Migration Data Summary ===');

  let totalMigrations = 0;
  const fieldsToMigrate = [
    'address1', 'address2', 'city', 'county', 'postcode', 'country', 'address',
    'firstName', 'lastName', 'fullName',
    'avatarUrl', 'avatarUpdatedAt',
    'wishlist', 'wishlistUpdatedAt',
    'followedArtists', 'followedArtistsUpdatedAt',
    'adminNotes', 'deletedBy'
  ];

  for (const uid of Object.keys(customersMap)) {
    const customerDoc = customersMap[uid];
    for (const field of fieldsToMigrate) {
      if (customerDoc[field] !== undefined) {
        totalMigrations++;
      }
    }
  }

  console.log(`Total field values to migrate: ${totalMigrations}`);
}

main().catch(console.error);
