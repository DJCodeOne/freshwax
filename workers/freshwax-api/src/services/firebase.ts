// Firebase Service - Handles Firestore operations with service account authentication
// Uses REST API with JWT auth (compatible with Cloudflare Workers)

import type { Env, FirestoreDocument, FirestoreValue } from '../types';

// Cache for access tokens
let cachedToken: { token: string; expires: number } | null = null;

// Service account interface
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

// Base64URL encode
function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Create JWT for service account
async function createJWT(serviceAccount: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // 1 hour

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: serviceAccount.private_key_id
  };

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
async function getAccessToken(env: Env): Promise<string> {
  // Check cache
  if (cachedToken && Date.now() < cachedToken.expires - 60000) {
    return cachedToken.token;
  }

  const serviceAccount: ServiceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY);
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

// Firestore base URL
function getFirestoreUrl(env: Env, path: string): string {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

// Convert JS value to Firestore value
export function toFirestoreValue(value: any): FirestoreValue {
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
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

// Convert Firestore value to JS value
export function fromFirestoreValue(value: FirestoreValue): any {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue!, 10);
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

// Convert Firestore document to plain object
export function documentToObject(doc: FirestoreDocument): Record<string, any> {
  const result: Record<string, any> = {};
  const fields = doc.fields || {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = fromFirestoreValue(value);
  }
  // Extract document ID from name
  const nameParts = doc.name.split('/');
  result.id = nameParts[nameParts.length - 1];
  return result;
}

// ============================================
// FIRESTORE OPERATIONS
// ============================================

// Get a single document
export async function getDocument(
  env: Env,
  collection: string,
  docId: string
): Promise<Record<string, any> | null> {
  const token = await getAccessToken(env);
  const url = getFirestoreUrl(env, `${collection}/${docId}`);

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get document: ${error}`);
  }

  const doc = await response.json() as FirestoreDocument;
  return documentToObject(doc);
}

// Create or update a document
export async function setDocument(
  env: Env,
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<Record<string, any>> {
  const token = await getAccessToken(env);
  const url = getFirestoreUrl(env, `${collection}/${docId}`);

  const fields: Record<string, FirestoreValue> = {};
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

  const doc = await response.json() as FirestoreDocument;
  return documentToObject(doc);
}

// Helper to set nested value by dot-notation path
function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

// Update specific fields in a document
export async function updateDocument(
  env: Env,
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<Record<string, any>> {
  const token = await getAccessToken(env);

  // Build update mask - encode special characters in field paths
  const updateMask = Object.keys(data)
    .map(key => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join('&');
  const url = `${getFirestoreUrl(env, `${collection}/${docId}`)}?${updateMask}`;

  // Convert dot-notation keys into nested structure
  const nestedData: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    setNestedValue(nestedData, key, value);
  }

  // Convert to Firestore format
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(nestedData)) {
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

  const doc = await response.json() as FirestoreDocument;
  return documentToObject(doc);
}

// Delete a document
export async function deleteDocument(
  env: Env,
  collection: string,
  docId: string
): Promise<void> {
  const token = await getAccessToken(env);
  const url = getFirestoreUrl(env, `${collection}/${docId}`);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    throw new Error(`Failed to delete document: ${error}`);
  }
}

// Query a collection
export async function queryCollection(
  env: Env,
  collection: string,
  options: {
    filters?: Array<{ field: string; op: string; value: any }>;
    orderBy?: { field: string; direction?: 'ASCENDING' | 'DESCENDING' };
    limit?: number;
  } = {}
): Promise<Record<string, any>[]> {
  const token = await getAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;

  const structuredQuery: any = {
    from: [{ collectionId: collection }]
  };

  // Add filters
  if (options.filters && options.filters.length > 0) {
    if (options.filters.length === 1) {
      const f = options.filters[0];
      structuredQuery.where = {
        fieldFilter: {
          field: { fieldPath: f.field },
          op: f.op,
          value: toFirestoreValue(f.value)
        }
      };
    } else {
      structuredQuery.where = {
        compositeFilter: {
          op: 'AND',
          filters: options.filters.map(f => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op,
              value: toFirestoreValue(f.value)
            }
          }))
        }
      };
    }
  }

  // Add orderBy
  if (options.orderBy) {
    structuredQuery.orderBy = [{
      field: { fieldPath: options.orderBy.field },
      direction: options.orderBy.direction || 'ASCENDING'
    }];
  }

  // Add limit
  if (options.limit) {
    structuredQuery.limit = options.limit;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ structuredQuery })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to query collection: ${error}`);
  }

  const results = await response.json() as Array<{ document?: FirestoreDocument }>;

  return results
    .filter(r => r.document)
    .map(r => documentToObject(r.document!));
}

// Add a document with auto-generated ID
export async function addDocument(
  env: Env,
  collection: string,
  data: Record<string, any>
): Promise<Record<string, any>> {
  const token = await getAccessToken(env);
  const url = `${getFirestoreUrl(env, collection)}`;

  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to add document: ${error}`);
  }

  const doc = await response.json() as FirestoreDocument;
  return documentToObject(doc);
}

// Batch write (for atomic operations)
export async function batchWrite(
  env: Env,
  writes: Array<{
    type: 'set' | 'update' | 'delete';
    collection: string;
    docId: string;
    data?: Record<string, any>;
  }>
): Promise<void> {
  const token = await getAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:batchWrite`;

  const writeOps = writes.map(w => {
    const docPath = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${w.collection}/${w.docId}`;

    if (w.type === 'delete') {
      return { delete: docPath };
    }

    const fields: Record<string, FirestoreValue> = {};
    if (w.data) {
      for (const [key, value] of Object.entries(w.data)) {
        fields[key] = toFirestoreValue(value);
      }
    }

    return {
      update: {
        name: docPath,
        fields
      }
    };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ writes: writeOps })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to batch write: ${error}`);
  }
}
