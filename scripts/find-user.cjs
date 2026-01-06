// scripts/find-user.cjs
// Find user accounts by email pattern
// Usage: node scripts/find-user.cjs <email-pattern>

const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, '..', 'freshwax-store-firebase-adminsdk.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'freshwax-store'
});

const auth = admin.auth();
const db = admin.firestore();

async function findUsers(pattern) {
  console.log(`Searching for users matching: ${pattern}\n`);

  // Search Firebase Auth
  console.log('=== Firebase Auth ===');
  const emails = [
    `${pattern}@gmail.com`,
    `${pattern}@googlemail.com`
  ];

  for (const email of emails) {
    try {
      const user = await auth.getUserByEmail(email);
      console.log(`Found: ${email}`);
      console.log(`  UID: ${user.uid}`);
      console.log(`  Display Name: ${user.displayName || 'N/A'}`);
      console.log(`  Provider: ${user.providerData[0]?.providerId || 'N/A'}`);
      console.log(`  Created: ${user.metadata.creationTime}`);
      console.log('');
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        console.log(`Not found: ${email}`);
      } else {
        console.log(`Error for ${email}:`, e.message);
      }
    }
  }

  // Search Firestore users collection
  console.log('\n=== Firestore Users ===');
  const usersRef = db.collection('users');

  for (const email of emails) {
    const snapshot = await usersRef.where('email', '==', email).get();
    if (!snapshot.empty) {
      snapshot.forEach(doc => {
        const data = doc.data();
        console.log(`Found: ${email}`);
        console.log(`  Doc ID: ${doc.id}`);
        console.log(`  Display Name: ${data.displayName || 'N/A'}`);
        console.log(`  Roles:`, data.roles || 'N/A');
        console.log(`  Subscription:`, data.subscription || 'N/A');
        console.log('');
      });
    } else {
      console.log(`Not found in Firestore: ${email}`);
    }
  }

  // Check admins
  console.log('\n=== Checking Admin Status ===');
  const ADMIN_EMAILS = process.env.ADMIN_EMAILS || 'davidhagon@gmail.com';
  console.log('Admin emails configured:', ADMIN_EMAILS);
}

const pattern = process.argv[2] || 'davidhagon';
findUsers(pattern).then(() => process.exit(0)).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
