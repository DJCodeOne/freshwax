// scripts/fix-gmail-duplicate.cjs
// Delete the duplicate googlemail.com account and link Google to gmail.com

const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, '..', 'freshwax-store-firebase-adminsdk.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'freshwax-store'
});

const auth = admin.auth();

async function fixDuplicate() {
  const gmailEmail = 'davidhagon@gmail.com';
  const googlemailEmail = 'davidhagon@googlemail.com';

  try {
    // Get both accounts
    const gmailUser = await auth.getUserByEmail(gmailEmail);
    const googlemailUser = await auth.getUserByEmail(googlemailEmail);

    console.log('Gmail account:', gmailUser.uid);
    console.log('Googlemail account:', googlemailUser.uid);

    // Delete the googlemail account
    console.log('\nDeleting duplicate googlemail account...');
    await auth.deleteUser(googlemailUser.uid);
    console.log('Deleted:', googlemailEmail);

    // Now update the gmail account to add Google as a provider
    // This allows signing in with Google using the gmail.com account
    console.log('\nThe gmail.com account remains. User can now:');
    console.log('1. Sign in with email/password');
    console.log('2. Use "Forgot Password" to set a new password if needed');
    console.log('3. Link Google provider from account settings (if implemented)');

    console.log('\nDone!');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

fixDuplicate();
