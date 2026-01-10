// Fix mix duration in Firebase
// Usage: node scripts/fix-mix-duration.js <mixId> <durationSeconds>

const https = require('https');

const mixId = process.argv[2] || 'mix_1767727785441_vnrcm5j0';
const durationSeconds = parseInt(process.argv[3], 10) || 3535;

// Format duration
const hours = Math.floor(durationSeconds / 3600);
const mins = Math.floor((durationSeconds % 3600) / 60);
const secs = durationSeconds % 60;
const formatted = hours > 0
  ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  : `${mins}:${String(secs).padStart(2, '0')}`;

console.log(`Fixing mix: ${mixId}`);
console.log(`Duration: ${durationSeconds}s = ${formatted}`);

// Use Firestore REST API with service account auth would require the key
// For now, output the curl command to run manually

console.log('\nTo update in Firebase Console:');
console.log('1. Go to: https://console.firebase.google.com/project/freshwax-store/firestore/data/~2Fdj-mixes~2F' + mixId);
console.log('2. Update these fields:');
console.log(`   - duration: "${formatted}"`);
console.log(`   - durationSeconds: ${durationSeconds}`);
console.log(`   - durationFormatted: "${formatted}"`);
