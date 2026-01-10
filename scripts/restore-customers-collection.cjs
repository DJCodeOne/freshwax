/**
 * ROLLBACK SCRIPT: Restore customers collection from backup
 *
 * This script:
 * 1. Reads the backup JSON file
 * 2. Restores all customer documents exactly as they were
 * 3. Optionally reverts users collection to pre-migration state
 *
 * Usage:
 *   node scripts/restore-customers-collection.cjs --dry-run              # Show what would be restored
 *   node scripts/restore-customers-collection.cjs --execute              # Restore customers collection
 *   node scripts/restore-customers-collection.cjs --execute --full       # Restore both collections
 */

require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'freshwax-store';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Command line args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EXECUTE = args.includes('--execute');
const FULL_RESTORE = args.includes('--full');

if (!DRY_RUN && !EXECUTE) {
  console.log('ROLLBACK SCRIPT - Restore from backup\n');
  console.log('Usage:');
  console.log('  node scripts/restore-customers-collection.cjs --dry-run         # Show what would be restored');
  console.log('  node scripts/restore-customers-collection.cjs --execute         # Restore customers collection');
  console.log('  node scripts/restore-customers-collection.cjs --execute --full  # Restore BOTH collections\n');

  // List available backups
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (fs.existsSync(backupsDir)) {
    const backups = fs.readdirSync(backupsDir).filter(f => f.startsWith('migration-'));
    if (backups.length > 0) {
      console.log('Available backups:');
      backups.forEach(b => console.log(`  - ${b}`));
    }
  }
  process.exit(1);
}

// Find the most recent backup
function findLatestBackup() {
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupsDir)) {
    return null;
  }

  const backups = fs.readdirSync(backupsDir)
    .filter(f => f.startsWith('migration-'))
    .sort()
    .reverse();

  if (backups.length === 0) return null;
  return path.join(backupsDir, backups[0]);
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

function setDocument(collection, docId, fields, accessToken) {
  return new Promise((resolve, reject) => {
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
        if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 409) {
          // 409 means doc exists, try PATCH instead
          if (res.statusCode === 409) {
            updateDocument(collection, docId, fields, accessToken).then(resolve).catch(reject);
          } else {
            resolve(true);
          }
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

function updateDocument(collection, docId, fields, accessToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fields });

    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`,
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

function plainToFirestore(obj) {
  const fields = {};

  function convert(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'string') {
      // Check if it looks like a timestamp
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        return { stringValue: value }; // Keep as string for consistency
      }
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return { integerValue: String(value) };
      return { doubleValue: value };
    }
    if (typeof value === 'boolean') return { booleanValue: value };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(convert) } };
    }
    if (typeof value === 'object') {
      // Check if it's a Firestore timestamp object
      if (value._seconds !== undefined) {
        const date = new Date(value._seconds * 1000);
        return { timestampValue: date.toISOString() };
      }
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

// === Main Restore Logic ===

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ROLLBACK - RESTORE FROM BACKUP                          ║');
  console.log('║                                                          ║');
  if (DRY_RUN) {
    console.log('║  MODE: DRY RUN (no changes will be made)                 ║');
  } else if (FULL_RESTORE) {
    console.log('║  MODE: FULL RESTORE (customers + users)                  ║');
  } else {
    console.log('║  MODE: RESTORE CUSTOMERS ONLY                            ║');
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Find backup
  const backupDir = findLatestBackup();
  if (!backupDir) {
    console.log('ERROR: No backup found in backups/ directory');
    process.exit(1);
  }

  console.log(`Using backup: ${backupDir}\n`);

  // Load backup files
  const customersBackupPath = path.join(backupDir, 'customers-backup.json');
  const usersBackupPath = path.join(backupDir, 'users-backup.json');

  if (!fs.existsSync(customersBackupPath)) {
    console.log('ERROR: customers-backup.json not found in backup directory');
    process.exit(1);
  }

  const customersBackup = JSON.parse(fs.readFileSync(customersBackupPath, 'utf8'));
  console.log(`Loaded ${customersBackup.length} customer documents from backup`);

  let usersBackup = [];
  if (FULL_RESTORE && fs.existsSync(usersBackupPath)) {
    usersBackup = JSON.parse(fs.readFileSync(usersBackupPath, 'utf8'));
    console.log(`Loaded ${usersBackup.length} user documents from backup`);
  }

  console.log('');

  if (DRY_RUN) {
    console.log('Documents that would be restored:\n');
    console.log('CUSTOMERS:');
    for (const doc of customersBackup) {
      const email = doc.email || doc.displayName || doc._id;
      console.log(`  - ${email}`);
    }

    if (FULL_RESTORE && usersBackup.length > 0) {
      console.log('\nUSERS:');
      for (const doc of usersBackup) {
        const email = doc.email || doc.displayName || doc._id;
        console.log(`  - ${email}`);
      }
    }

    console.log('\n⚠ This was a dry run. To execute, run with --execute');
    return;
  }

  // Authenticate
  console.log('Authenticating...');
  const accessToken = await getAccessToken();
  console.log('✓ Authenticated\n');

  // Restore customers
  console.log('Restoring customers collection...');
  let successCount = 0;
  let errorCount = 0;

  for (const doc of customersBackup) {
    const docId = doc._id;
    try {
      const fields = plainToFirestore(doc);
      await setDocument('customers', docId, fields, accessToken);
      console.log(`  ✓ ${doc.email || doc.displayName || docId}`);
      successCount++;
    } catch (err) {
      console.log(`  ✗ ${docId}: ${err.message}`);
      errorCount++;
    }
  }

  console.log(`\nCustomers: ${successCount} restored, ${errorCount} errors`);

  // Restore users if full restore
  if (FULL_RESTORE && usersBackup.length > 0) {
    console.log('\nRestoring users collection...');
    successCount = 0;
    errorCount = 0;

    for (const doc of usersBackup) {
      const docId = doc._id;
      try {
        const fields = plainToFirestore(doc);
        await setDocument('users', docId, fields, accessToken);
        console.log(`  ✓ ${doc.email || doc.displayName || docId}`);
        successCount++;
      } catch (err) {
        console.log(`  ✗ ${docId}: ${err.message}`);
        errorCount++;
      }
    }

    console.log(`\nUsers: ${successCount} restored, ${errorCount} errors`);
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  RESTORE COMPLETE                                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\nNext steps if rolling back code:');
  console.log('  1. git checkout main');
  console.log('  2. npm run build');
  console.log('  3. npm run deploy (or deploy to Cloudflare)');
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
