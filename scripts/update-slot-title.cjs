// Quick script to update livestream slot title
// Usage: node scripts/update-slot-title.cjs <slotId> "<new title>"

const https = require('https');

const slotId = process.argv[2];
const newTitle = process.argv[3];

if (!slotId || !newTitle) {
  console.log('Usage: node scripts/update-slot-title.cjs <slotId> "<new title>"');
  process.exit(1);
}

// Use Firebase REST API with API key (for public writes this may not work due to rules)
// For now, directly call Firestore REST API
const projectId = 'freshwax-store';
const apiKey = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/livestreamSlots/${slotId}?updateMask.fieldPaths=title&key=${apiKey}`;

const data = JSON.stringify({
  fields: {
    title: { stringValue: newTitle }
  }
});

const options = {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(url, options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('Title updated to:', newTitle);
    } else {
      console.error('Error:', res.statusCode, body);
    }
  });
});

req.on('error', (e) => console.error('Request error:', e.message));
req.write(data);
req.end();
