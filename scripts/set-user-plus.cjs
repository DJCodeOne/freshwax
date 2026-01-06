// Set user to Plus subscription
// Usage: node scripts/set-user-plus.cjs <userId>

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
const serviceAccount = require(path.join(__dirname, '..', 'freshwax-store-firebase-adminsdk.json'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function setUserPlus(userId) {
  if (!userId) {
    console.error('Usage: node scripts/set-user-plus.cjs <userId>');
    process.exit(1);
  }

  try {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.error('User not found:', userId);
      process.exit(1);
    }

    const userData = userDoc.data();
    console.log('Current user:', userData.displayName || userData.name || userId);
    console.log('Current subscription:', userData.subscription || 'None');

    // Set Plus subscription for 1 year
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await userRef.update({
      subscription: {
        tier: 'pro',
        expiresAt: expiresAt.toISOString(),
        startedAt: new Date().toISOString(),
        source: 'admin'
      },
      updatedAt: new Date().toISOString()
    });

    console.log('✓ Set Plus subscription until:', expiresAt.toISOString());
    console.log('User can now access Plus features including cloud playlist sync');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  process.exit(0);
}

const userId = process.argv[2] || '8WmxYeCp4PSym5iWHahgizokn5F2';
setUserPlus(userId);
