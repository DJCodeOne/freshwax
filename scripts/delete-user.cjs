// scripts/delete-user.cjs
// Delete a user from both Firestore and Firebase Auth
// Usage: node scripts/delete-user.cjs <email>

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, '..', 'freshwax-store-firebase-adminsdk.json');

try {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'freshwax-store'
  });
} catch (err) {
  console.error('Error loading service account:', err.message);
  console.log('Make sure freshwax-store-firebase-adminsdk.json exists in project root');
  process.exit(1);
}

const db = admin.firestore();
const auth = admin.auth();

async function deleteUser(email) {
  console.log(`Deleting user: ${email}`);

  // 1. Find user in Firestore by email
  const usersRef = db.collection('users');
  const snapshot = await usersRef.where('email', '==', email).get();

  if (snapshot.empty) {
    console.log('No user found in Firestore with that email');
  } else {
    for (const doc of snapshot.docs) {
      console.log(`Deleting Firestore document: ${doc.id}`);
      await doc.ref.delete();
      console.log('Firestore document deleted');
    }
  }

  // 2. Delete from Firebase Auth
  try {
    const userRecord = await auth.getUserByEmail(email);
    console.log(`Found Auth user: ${userRecord.uid}`);
    await auth.deleteUser(userRecord.uid);
    console.log('Firebase Auth user deleted');
  } catch (authErr) {
    if (authErr.code === 'auth/user-not-found') {
      console.log('No user found in Firebase Auth');
    } else {
      console.error('Auth deletion error:', authErr.message);
    }
  }

  // 3. Check for any related data (subscribers, etc.)
  try {
    const subscriberId = email.toLowerCase().replace(/[.@]/g, '_');
    const subscriberDoc = await db.collection('subscribers').doc(subscriberId).get();
    if (subscriberDoc.exists) {
      console.log('Note: User has a newsletter subscription (not deleted)');
    }
  } catch (e) {
    // Ignore
  }

  console.log('\nDone! User can now re-register with this email.');
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/delete-user.cjs <email>');
  process.exit(1);
}

deleteUser(email).then(() => process.exit(0)).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
