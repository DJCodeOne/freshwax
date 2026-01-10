// Comprehensive analysis of users and customers collections
// Identifies all fields, their types, and usage patterns

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

function getFieldType(value) {
  if (value.stringValue !== undefined) return 'string';
  if (value.integerValue !== undefined) return 'integer';
  if (value.doubleValue !== undefined) return 'double';
  if (value.booleanValue !== undefined) return 'boolean';
  if (value.timestampValue !== undefined) return 'timestamp';
  if (value.nullValue !== undefined) return 'null';
  if (value.arrayValue) return 'array';
  if (value.mapValue) return 'map';
  return 'unknown';
}

function extractMapFields(mapValue, prefix = '') {
  const fields = {};
  if (mapValue && mapValue.fields) {
    for (const [key, value] of Object.entries(mapValue.fields)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      fields[fullKey] = getFieldType(value);
      if (value.mapValue) {
        Object.assign(fields, extractMapFields(value.mapValue, fullKey));
      }
    }
  }
  return fields;
}

function analyzeCollection(docs) {
  const fieldStats = {};

  for (const doc of docs) {
    if (!doc.fields) continue;

    for (const [key, value] of Object.entries(doc.fields)) {
      const type = getFieldType(value);

      if (!fieldStats[key]) {
        fieldStats[key] = { type, count: 0, examples: [] };
      }
      fieldStats[key].count++;

      // Collect sample values
      if (fieldStats[key].examples.length < 2) {
        let sampleValue;
        if (type === 'string') sampleValue = value.stringValue?.substring(0, 50);
        else if (type === 'boolean') sampleValue = value.booleanValue;
        else if (type === 'integer') sampleValue = value.integerValue;
        else if (type === 'map') sampleValue = '{...}';
        else if (type === 'array') sampleValue = '[...]';
        else if (type === 'timestamp') sampleValue = value.timestampValue?.substring(0, 10);
        else sampleValue = type;

        if (sampleValue && !fieldStats[key].examples.includes(sampleValue)) {
          fieldStats[key].examples.push(sampleValue);
        }
      }

      // Expand map fields
      if (type === 'map') {
        const nestedFields = extractMapFields(value.mapValue, key);
        for (const [nestedKey, nestedType] of Object.entries(nestedFields)) {
          if (!fieldStats[nestedKey]) {
            fieldStats[nestedKey] = { type: nestedType, count: 0, examples: [], nested: true };
          }
          fieldStats[nestedKey].count++;
        }
      }
    }
  }

  return fieldStats;
}

async function main() {
  console.log('=== Collection Schema Analysis ===\n');

  const accessToken = await getAccessToken();

  // Fetch both collections
  console.log('Fetching collections...');
  const [usersDocs, customersDocs] = await Promise.all([
    fetchCollection('users', accessToken),
    fetchCollection('customers', accessToken)
  ]);

  console.log(`Users: ${usersDocs.length} documents`);
  console.log(`Customers: ${customersDocs.length} documents\n`);

  // Analyze each collection
  const usersFields = analyzeCollection(usersDocs);
  const customersFields = analyzeCollection(customersDocs);

  // Print Users schema
  console.log('=== USERS COLLECTION SCHEMA ===');
  console.log('Field | Type | Count | Examples');
  console.log('------|------|-------|----------');
  for (const [field, stats] of Object.entries(usersFields).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!stats.nested) {
      console.log(`${field} | ${stats.type} | ${stats.count}/${usersDocs.length} | ${stats.examples.join(', ')}`);
    }
  }

  // Print nested fields
  console.log('\nNested fields in users:');
  for (const [field, stats] of Object.entries(usersFields).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (stats.nested) {
      console.log(`  ${field} | ${stats.type} | ${stats.count}`);
    }
  }

  console.log('\n=== CUSTOMERS COLLECTION SCHEMA ===');
  console.log('Field | Type | Count | Examples');
  console.log('------|------|-------|----------');
  for (const [field, stats] of Object.entries(customersFields).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!stats.nested) {
      console.log(`${field} | ${stats.type} | ${stats.count}/${customersDocs.length} | ${stats.examples.join(', ')}`);
    }
  }

  // Print nested fields
  console.log('\nNested fields in customers:');
  for (const [field, stats] of Object.entries(customersFields).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (stats.nested) {
      console.log(`  ${field} | ${stats.type} | ${stats.count}`);
    }
  }

  // Identify overlapping vs unique fields
  const usersOnlyFields = Object.keys(usersFields).filter(f => !customersFields[f] && !usersFields[f].nested);
  const customersOnlyFields = Object.keys(customersFields).filter(f => !usersFields[f] && !customersFields[f].nested);
  const sharedFields = Object.keys(usersFields).filter(f => customersFields[f] && !usersFields[f].nested);

  console.log('\n=== FIELD ANALYSIS ===');
  console.log('\nSHARED FIELDS (in both collections):');
  sharedFields.forEach(f => console.log(`  - ${f}`));

  console.log('\nUSERS-ONLY FIELDS:');
  usersOnlyFields.forEach(f => console.log(`  - ${f} (${usersFields[f].type})`));

  console.log('\nCUSTOMERS-ONLY FIELDS (need to migrate):');
  customersOnlyFields.forEach(f => console.log(`  - ${f} (${customersFields[f].type})`));

  console.log('\n=== MIGRATION SUMMARY ===');
  console.log(`Total users: ${usersDocs.length}`);
  console.log(`Total customers: ${customersDocs.length}`);
  console.log(`Shared fields: ${sharedFields.length}`);
  console.log(`Users-only fields: ${usersOnlyFields.length}`);
  console.log(`Customers-only fields to migrate: ${customersOnlyFields.length}`);
}

main().catch(console.error);
