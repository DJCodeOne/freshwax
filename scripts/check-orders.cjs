// Check recent orders in Firestore
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: process.env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}

(async () => {
  const tok = await getToken();
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
        limit: 10
      }
    })
  });
  const data = await r.json();
  const docs = (data || []).filter(d => d.document);
  console.log('Orders found:', docs.length);
  docs.forEach(d => {
    const f = d.document.fields || {};
    const id = d.document.name.split('/').pop();
    const num = f.orderNumber?.stringValue || '?';
    const custFields = f.customer?.mapValue?.fields || {};
    const email = custFields.email?.stringValue || '?';
    const userId = custFields.userId?.stringValue || '?';
    const created = f.createdAt?.stringValue || '?';
    const status = f.status?.stringValue || f.paymentStatus?.stringValue || '?';
    const method = f.paymentMethod?.stringValue || '?';
    const totalFields = f.totals?.mapValue?.fields || {};
    const total = totalFields.total?.doubleValue || totalFields.total?.integerValue || '?';
    const items = f.items?.arrayValue?.values || [];
    const itemNames = items.map(i => {
      const iFields = i.mapValue?.fields || {};
      return iFields.name?.stringValue || iFields.title?.stringValue || '?';
    }).join(', ');
    console.log(`\n  ${num} (${id})`);
    console.log(`    Email: ${email} | User: ${userId}`);
    console.log(`    Status: ${status} | Method: ${method} | Total: ${total}`);
    console.log(`    Created: ${created}`);
    console.log(`    Items: ${itemNames}`);
  });
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
