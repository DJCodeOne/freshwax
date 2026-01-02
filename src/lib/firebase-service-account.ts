// src/lib/firebase-service-account.ts
// Firebase REST API operations using service account authentication
// Works in Cloudflare Workers (no Node.js dependencies)

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

// Cache for access tokens
let cachedToken: { token: string; expires: number } | null = null;

// Base64URL encode
function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Create JWT for service account
async function createJWT(serviceAccount: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // 1 hour

  const header: Record<string, string> = {
    alg: 'RS256',
    typ: 'JWT'
  };
  // Only include kid if we have a real private_key_id
  if (serviceAccount.private_key_id && serviceAccount.private_key_id !== 'auto') {
    header.kid = serviceAccount.private_key_id;
  }

  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: exp,
    scope: 'https://www.googleapis.com/auth/datastore'
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${headerB64}.${payloadB64}`;

  // Import the private key and sign
  const privateKey = serviceAccount.private_key;
  const pemContents = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  const signatureB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// Get access token from service account
export async function getServiceAccountToken(serviceAccountKey: string): Promise<string> {
  // Check cache
  if (cachedToken && Date.now() < cachedToken.expires - 60000) {
    return cachedToken.token;
  }

  const serviceAccount: ServiceAccount = JSON.parse(serviceAccountKey);
  const jwt = await createJWT(serviceAccount);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get access token: ${error}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  cachedToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in * 1000)
  };

  return cachedToken.token;
}

// Convert JS value to Firestore value
function toFirestoreValue(value: any): any {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

// Convert Firestore value to JS value
function fromFirestoreValue(value: any): any {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) {
    return (value.arrayValue?.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in value) {
    const result: Record<string, any> = {};
    const fields = value.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  return null;
}

// Get Firestore URL
function getFirestoreUrl(projectId: string, path: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
}

// Get a document with service account auth
export async function saGetDocument(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  docId: string
): Promise<Record<string, any> | null> {
  const token = await getServiceAccountToken(serviceAccountKey);
  const url = getFirestoreUrl(projectId, `${collection}/${docId}`);

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get document: ${error}`);
  }

  const doc = await response.json() as any;

  // Convert to plain object
  const result: Record<string, any> = {};
  const fields = doc.fields || {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = fromFirestoreValue(value);
  }
  result.id = docId;

  return result;
}

// Set a document with service account auth (full replace)
export async function saSetDocument(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<Record<string, any>> {
  const token = await getServiceAccountToken(serviceAccountKey);
  const url = getFirestoreUrl(projectId, `${collection}/${docId}`);

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set document: ${error}`);
  }

  const doc = await response.json() as any;

  // Convert to plain object
  const result: Record<string, any> = {};
  const docFields = doc.fields || {};
  for (const [key, value] of Object.entries(docFields)) {
    result[key] = fromFirestoreValue(value);
  }
  result.id = docId;

  return result;
}

// Update specific fields with service account auth
export async function saUpdateDocument(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<Record<string, any>> {
  const token = await getServiceAccountToken(serviceAccountKey);

  // Build update mask
  const updateMask = Object.keys(data)
    .map(key => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join('&');
  const url = `${getFirestoreUrl(projectId, `${collection}/${docId}`)}?${updateMask}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update document: ${error}`);
  }

  const doc = await response.json() as any;

  const result: Record<string, any> = {};
  const docFields = doc.fields || {};
  for (const [key, value] of Object.entries(docFields)) {
    result[key] = fromFirestoreValue(value);
  }
  result.id = docId;

  return result;
}
