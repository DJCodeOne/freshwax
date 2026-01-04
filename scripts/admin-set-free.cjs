// Admin script to set a release price to free
// Run with: node scripts/admin-set-free.cjs <email> <password>
// This authenticates as admin and updates the release

const https = require('https');

const releaseId = 'code_one_FW-1765803666207';
const apiKey = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
const projectId = 'freshwax-store';

// Get credentials from command line
const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.log('Usage: node scripts/admin-set-free.cjs <email> <password>');
  console.log('Example: node scripts/admin-set-free.cjs admin@example.com yourpassword');
  process.exit(1);
}

// Helper to make HTTPS requests
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('Authenticating with Firebase...');

  // Step 1: Sign in with email/password
  const authData = JSON.stringify({
    email: email,
    password: password,
    returnSecureToken: true
  });

  const authResult = await httpsRequest({
    hostname: 'identitytoolkit.googleapis.com',
    path: `/v1/accounts:signInWithPassword?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(authData)
    }
  }, authData);

  if (authResult.status !== 200 || !authResult.data.idToken) {
    console.error('Authentication failed:', authResult.data.error?.message || 'Unknown error');
    process.exit(1);
  }

  const idToken = authResult.data.idToken;
  console.log('Authenticated successfully as:', authResult.data.email);

  // Step 2: Update the release pricing
  console.log('Updating release:', releaseId);

  const updateData = JSON.stringify({
    fields: {
      pricing: {
        mapValue: {
          fields: {
            digital: { integerValue: "0" },
            track: { integerValue: "0" },
            vinyl: { nullValue: null }
          }
        }
      },
      pricePerSale: { integerValue: "0" },
      trackPrice: { integerValue: "0" }
    }
  });

  const updateMask = 'updateMask.fieldPaths=pricing&updateMask.fieldPaths=pricePerSale&updateMask.fieldPaths=trackPrice';

  const updateResult = await httpsRequest({
    hostname: 'firestore.googleapis.com',
    path: `/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}?${updateMask}&key=${apiKey}`,
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      'Content-Length': Buffer.byteLength(updateData)
    }
  }, updateData);

  if (updateResult.status === 200) {
    console.log('SUCCESS! Release pricing updated to free.');
    console.log('Release ID:', releaseId);
    console.log('New pricing: digital=0, track=0');
  } else {
    console.error('Update failed:', updateResult.status);
    console.error(updateResult.data);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
