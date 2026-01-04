// Script to set a release price to 0 (free)
// Run with: node scripts/set-release-free.cjs
// This uses the Firebase REST API with a service account workaround

const https = require('https');

const releaseId = 'code_one_FW-1765803666207';
const apiKey = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
const projectId = 'freshwax-store';

// Build the update request
const updateData = {
  fields: {
    pricing: {
      mapValue: {
        fields: {
          digital: { integerValue: "0" },
          track: { integerValue: "0" },
          vinyl: { nullValue: null }
        }
      }
    }
  }
};

// Build updateMask for pricing fields
const updateMask = 'updateMask.fieldPaths=pricing';
const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}?${updateMask}&key=${apiKey}`;

console.log('Updating release:', releaseId);
console.log('Setting pricing to: digital=0, track=0, vinyl=null');

const data = JSON.stringify(updateData);

const urlObj = new URL(url);
const options = {
  hostname: urlObj.hostname,
  path: urlObj.pathname + urlObj.search,
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('SUCCESS! Release pricing updated to free.');
      console.log('Release ID:', releaseId);
      // Parse response to show new pricing
      try {
        const result = JSON.parse(body);
        console.log('New pricing:', result.fields?.pricing?.mapValue?.fields);
      } catch (e) {
        console.log('Response received');
      }
    } else {
      console.log('Status:', res.statusCode);
      console.log('Response:', body);

      if (res.statusCode === 403) {
        console.log('\nPermission denied. You need to update the Firestore rules or use Firebase Admin SDK.');
        console.log('\nAlternative: Update manually in Firebase Console:');
        console.log('1. Go to https://console.firebase.google.com/project/freshwax-store/firestore');
        console.log('2. Navigate to: releases/' + releaseId);
        console.log('3. Edit pricing.digital = 0 and pricing.track = 0');
      }
    }
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.write(data);
req.end();
