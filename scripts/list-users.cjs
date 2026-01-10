const https = require('https');
const API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
const PROJECT_ID = 'freshwax-store';

https.get(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users?pageSize=100&key=${API_KEY}`, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    const docs = json.documents || [];
    console.log('#  | UID                        | Email                              | Name');
    console.log('---|----------------------------|-------------------------------------|------------------------');
    docs.forEach((doc, i) => {
      const f = doc.fields || {};
      const id = doc.name.split('/').pop().padEnd(26);
      const email = (f.email?.stringValue || '(none)').padEnd(35);
      const name = f.displayName?.stringValue || f.name?.stringValue || '(none)';
      console.log(`${String(i+1).padStart(2)} | ${id} | ${email} | ${name}`);
    });
    console.log(`\nTotal: ${docs.length} users`);
  });
});
