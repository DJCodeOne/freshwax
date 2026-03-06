// scripts/remove-color-variant.cjs
// Remove a specific color from a merch product's variant stock using service account auth
// Usage: node scripts/remove-color-variant.cjs <productId> <color>

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'freshwax-store';
const productId = process.argv[2];
const colorToRemove = process.argv[3];

if (!productId || !colorToRemove) {
  console.log('Usage: node scripts/remove-color-variant.cjs <productId> <color>');
  process.exit(1);
}

// Load env vars from .env file
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const vars = {};
  content.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) vars[match[1].trim()] = match[2].trim();
  });
  return vars;
}

// Get Google OAuth2 access token using service account
async function getAccessToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signInput = headerB64 + '.' + payloadB64;

  // Fix PEM formatting - strip quotes and convert literal \n to newlines
  let pem = privateKeyPem;
  if (pem.startsWith('"') && pem.endsWith('"')) {
    pem = pem.slice(1, -1);
  }
  pem = pem.replace(/\\n/g, '\n');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(pem, 'base64url');

  const jwt = signInput + '.' + signature;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) {
    throw new Error(`Auth error: ${tokenData.error_description}`);
  }
  return tokenData.access_token;
}

async function run() {
  const env = loadEnv();
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    console.error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in .env');
    process.exit(1);
  }

  console.log('Authenticating with service account...');
  const token = await getAccessToken(clientEmail, privateKey);

  // 1. Fetch current product
  const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/merch/${productId}`;
  const res = await fetch(docUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const doc = await res.json();

  if (doc.error) {
    console.error('Product not found:', doc.error.message);
    process.exit(1);
  }

  const fields = doc.fields || {};
  const vs = fields.variantStock?.mapValue?.fields || {};

  // 2. Find and remove matching variants
  const keysToRemove = Object.keys(vs).filter(k => k.endsWith('_' + colorToRemove));
  if (keysToRemove.length === 0) {
    console.log(`No variants found matching color "${colorToRemove}"`);
    console.log('Available keys:', Object.keys(vs).join(', '));
    process.exit(1);
  }

  console.log(`\nFound ${keysToRemove.length} variants to remove:`);
  let removedStock = 0;
  keysToRemove.forEach(k => {
    const stock = parseInt(vs[k]?.mapValue?.fields?.stock?.integerValue || '0');
    console.log(`  ${k}: ${stock} units`);
    removedStock += stock;
  });

  // 3. Build new variant stock without the removed color
  const newVariantStock = {};
  Object.keys(vs).forEach(k => {
    if (!keysToRemove.includes(k)) {
      newVariantStock[k] = vs[k];
    }
  });

  // 4. Also update colorList if present
  const colorList = fields.colorList?.arrayValue?.values?.map(v => v.stringValue) || [];
  const newColorList = colorList.filter(c => c.toLowerCase().replace(/\s+/g, '-') !== colorToRemove.toLowerCase());

  // 5. Also update colorNames if present
  const colorNames = fields.colorNames?.arrayValue?.values?.map(v => v.stringValue) || [];
  const newColorNames = colorNames.filter(c => c.toLowerCase().replace(/\s+/g, '-') !== colorToRemove.toLowerCase());

  // 6. Calculate new total stock
  const oldTotal = parseInt(fields.totalStock?.integerValue || '0');
  const newTotal = oldTotal - removedStock;

  console.log(`\nTotal stock: ${oldTotal} -> ${newTotal} (removing ${removedStock})`);
  console.log(`Remaining variants: ${Object.keys(newVariantStock).length}`);

  // 7. Update the document
  const updateFields = {
    variantStock: { mapValue: { fields: newVariantStock } },
    totalStock: { integerValue: String(newTotal) },
    updatedAt: { stringValue: new Date().toISOString() },
  };

  if (colorList.length > 0) {
    updateFields.colorList = {
      arrayValue: {
        values: newColorList.length > 0 ? newColorList.map(c => ({ stringValue: c })) : []
      }
    };
  }

  if (colorNames.length > 0) {
    updateFields.colorNames = {
      arrayValue: {
        values: newColorNames.length > 0 ? newColorNames.map(c => ({ stringValue: c })) : []
      }
    };
  }

  const updateUrl = `${docUrl}?updateMask.fieldPaths=variantStock&updateMask.fieldPaths=totalStock&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=colorList&updateMask.fieldPaths=colorNames`;

  const updateRes = await fetch(updateUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ fields: updateFields }),
  });

  const updateData = await updateRes.json();

  if (updateData.error) {
    console.error('\nUpdate failed:', updateData.error.message);
    process.exit(1);
  }

  console.log('\nDone! Dark green variants removed successfully.');
  console.log(`Product "${fields.name?.stringValue}" now has ${newTotal} stock across ${Object.keys(newVariantStock).length} variants.`);
}

run().catch(e => { console.error(e); process.exit(1); });
