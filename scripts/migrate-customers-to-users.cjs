/**
 * Migration Script: Merge customers collection into users collection
 *
 * This script:
 * 1. Backs up both collections to local JSON files
 * 2. Merges customer-only fields into users documents
 * 3. Validates the merge was successful
 * 4. Provides a dry-run mode for testing
 *
 * Usage:
 *   node scripts/migrate-customers-to-users.cjs --dry-run    # Test without changes
 *   node scripts/migrate-customers-to-users.cjs --execute    # Actually perform migration
 */

require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'freshwax-store';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Fields that exist ONLY in customers and need to be migrated
const CUSTOMER_ONLY_FIELDS = [
  'address1', 'address2', 'city', 'county', 'postcode', 'country',
  'firstName', 'lastName', 'fullName',
  'avatarUrl', 'avatarUpdatedAt',
  'wishlist', 'wishlistUpdatedAt',
  'followedArtists', 'followedArtistsUpdatedAt',
  'adminNotes', 'deletedBy'
];

// Command line args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EXECUTE = args.includes('--execute');

if (!DRY_RUN && !EXECUTE) {
  console.log('Usage:');
  console.log('  node scripts/migrate-customers-to-users.cjs --dry-run    # Test without changes');
  console.log('  node scripts/migrate-customers-to-users.cjs --execute    # Actually perform migration');
  process.exit(1);
}

// === Firebase Auth ===

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

// === Firestore Operations ===

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

function updateDocument(collection, docId, fields, accessToken) {
  return new Promise((resolve, reject) => {
    // Build update mask for only the fields we're adding
    const fieldPaths = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
    const body = JSON.stringify({ fields });

    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?${fieldPaths}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          const json = data ? JSON.parse(data) : {};
          reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// === Data Conversion ===

function firestoreToPlain(doc) {
  if (!doc || !doc.fields) return null;
  const result = { _id: doc.name.split('/').pop() };

  function convert(value) {
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.integerValue !== undefined) return parseInt(value.integerValue);
    if (value.doubleValue !== undefined) return value.doubleValue;
    if (value.booleanValue !== undefined) return value.booleanValue;
    if (value.timestampValue !== undefined) return value.timestampValue;
    if (value.nullValue !== undefined) return null;
    if (value.arrayValue) return (value.arrayValue.values || []).map(convert);
    if (value.mapValue) {
      const obj = {};
      for (const [k, v] of Object.entries(value.mapValue.fields || {})) {
        obj[k] = convert(v);
      }
      return obj;
    }
    return value;
  }

  for (const [key, value] of Object.entries(doc.fields)) {
    result[key] = convert(value);
  }
  return result;
}

function plainToFirestore(obj) {
  const fields = {};

  function convert(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return { integerValue: String(value) };
      return { doubleValue: value };
    }
    if (typeof value === 'boolean') return { booleanValue: value };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(convert) } };
    }
    if (typeof value === 'object') {
      const mapFields = {};
      for (const [k, v] of Object.entries(value)) {
        mapFields[k] = convert(v);
      }
      return { mapValue: { fields: mapFields } };
    }
    return { stringValue: String(value) };
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key !== '_id') {
      fields[key] = convert(value);
    }
  }
  return fields;
}

// === Main Migration Logic ===

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups', `migration-${timestamp}`);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  CUSTOMERS → USERS MIGRATION                             ║');
  console.log('║                                                          ║');
  if (DRY_RUN) {
    console.log('║  MODE: DRY RUN (no changes will be made)                 ║');
  } else {
    console.log('║  MODE: EXECUTE (changes WILL be made)                    ║');
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Step 1: Authenticate
  console.log('Step 1: Authenticating with Firebase...');
  const accessToken = await getAccessToken();
  console.log('  ✓ Authenticated\n');

  // Step 2: Fetch both collections
  console.log('Step 2: Fetching collections...');
  const [usersRaw, customersRaw] = await Promise.all([
    fetchCollection('users', accessToken),
    fetchCollection('customers', accessToken)
  ]);
  console.log(`  ✓ Users: ${usersRaw.length} documents`);
  console.log(`  ✓ Customers: ${customersRaw.length} documents\n`);

  // Convert to plain objects
  const usersMap = {};
  const customersMap = {};

  for (const doc of usersRaw) {
    const plain = firestoreToPlain(doc);
    usersMap[plain._id] = plain;
  }

  for (const doc of customersRaw) {
    const plain = firestoreToPlain(doc);
    customersMap[plain._id] = plain;
  }

  // Step 3: Create backup
  console.log('Step 3: Creating backup...');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(backupDir, 'users-backup.json'),
    JSON.stringify(Object.values(usersMap), null, 2)
  );
  fs.writeFileSync(
    path.join(backupDir, 'customers-backup.json'),
    JSON.stringify(Object.values(customersMap), null, 2)
  );
  console.log(`  ✓ Backup saved to: ${backupDir}\n`);

  // Step 4: Plan the migration
  console.log('Step 4: Planning migration...');
  const migrationPlan = [];

  for (const uid of Object.keys(usersMap)) {
    const userDoc = usersMap[uid];
    const customerDoc = customersMap[uid];

    if (!customerDoc) {
      console.log(`  ⚠ User ${uid} has no customer document (skipping)`);
      continue;
    }

    // Collect fields to migrate
    const fieldsToMigrate = {};
    for (const field of CUSTOMER_ONLY_FIELDS) {
      if (customerDoc[field] !== undefined && userDoc[field] === undefined) {
        fieldsToMigrate[field] = customerDoc[field];
      }
    }

    // Also migrate phone if customer has it but user doesn't
    if (customerDoc.phone && !userDoc.phone) {
      fieldsToMigrate.phone = customerDoc.phone;
    }

    if (Object.keys(fieldsToMigrate).length > 0) {
      migrationPlan.push({
        uid,
        email: userDoc.email,
        fieldsToMigrate,
        fieldCount: Object.keys(fieldsToMigrate).length
      });
    }
  }

  console.log(`  ✓ ${migrationPlan.length} users need field migration\n`);

  // Step 5: Show migration details
  console.log('Step 5: Migration details:');
  console.log('─'.repeat(60));

  let totalFields = 0;
  for (const plan of migrationPlan) {
    console.log(`  ${plan.email}:`);
    for (const [field, value] of Object.entries(plan.fieldsToMigrate)) {
      const displayValue = Array.isArray(value)
        ? `[${value.length} items]`
        : typeof value === 'object'
          ? '{...}'
          : String(value).substring(0, 40);
      console.log(`    + ${field}: ${displayValue}`);
      totalFields++;
    }
  }
  console.log('─'.repeat(60));
  console.log(`  Total: ${totalFields} fields to migrate\n`);

  // Step 6: Execute or dry-run
  if (DRY_RUN) {
    console.log('Step 6: DRY RUN - No changes made');
    console.log('  Run with --execute to perform the migration\n');
  } else {
    console.log('Step 6: Executing migration...');

    let successCount = 0;
    let errorCount = 0;

    for (const plan of migrationPlan) {
      try {
        const firestoreFields = plainToFirestore(plan.fieldsToMigrate);
        await updateDocument('users', plan.uid, firestoreFields, accessToken);
        console.log(`  ✓ ${plan.email} (${plan.fieldCount} fields)`);
        successCount++;
      } catch (err) {
        console.log(`  ✗ ${plan.email}: ${err.message}`);
        errorCount++;
      }
    }

    console.log('');
    console.log(`  Success: ${successCount}`);
    console.log(`  Errors: ${errorCount}\n`);
  }

  // Step 7: Validation
  console.log('Step 7: Validation...');

  if (!DRY_RUN) {
    // Re-fetch users to validate
    const updatedUsersRaw = await fetchCollection('users', accessToken);
    const updatedUsersMap = {};
    for (const doc of updatedUsersRaw) {
      const plain = firestoreToPlain(doc);
      updatedUsersMap[plain._id] = plain;
    }

    let validationErrors = 0;
    for (const plan of migrationPlan) {
      const updated = updatedUsersMap[plan.uid];
      for (const field of Object.keys(plan.fieldsToMigrate)) {
        if (updated[field] === undefined) {
          console.log(`  ✗ VALIDATION FAILED: ${plan.email}.${field} not found`);
          validationErrors++;
        }
      }
    }

    if (validationErrors === 0) {
      console.log('  ✓ All migrated fields validated successfully\n');
    } else {
      console.log(`  ✗ ${validationErrors} validation errors\n`);
    }
  } else {
    console.log('  (Skipped - dry run mode)\n');
  }

  // Save migration plan for reference
  fs.writeFileSync(
    path.join(backupDir, 'migration-plan.json'),
    JSON.stringify(migrationPlan, null, 2)
  );

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  MIGRATION COMPLETE                                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nBackup location: ${backupDir}`);

  if (DRY_RUN) {
    console.log('\n⚠ This was a dry run. To execute the migration, run:');
    console.log('  node scripts/migrate-customers-to-users.cjs --execute');
  } else {
    console.log('\n✓ Data migration complete.');
    console.log('\nNext steps:');
    console.log('  1. Update code to use only "users" collection');
    console.log('  2. Test all functionality');
    console.log('  3. Delete customers collection after verification');
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
