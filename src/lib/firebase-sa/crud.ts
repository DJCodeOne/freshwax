// src/lib/firebase-sa/crud.ts
// Firestore CRUD operations using service account authentication

import { createLogger, fetchWithTimeout } from '../api-utils';
import { getServiceAccountToken } from './auth';
import { toFirestoreValue, fromFirestoreValue } from './serialization';

const log = createLogger('firebase-service-account');

// Get Firestore URL
function getFirestoreUrl(projectId: string, path: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
}

// Helper to escape field paths with special characters (hyphens, etc.)
function escapeFieldPath(key: string): string {
  // If key contains special characters, wrap in backticks
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key)) {
    return `\`${key}\``;
  }
  return key;
}

// Convert flat dotted keys to nested Firestore structure
// e.g., {'subscription.expiresAt': 'value'} -> {subscription: {expiresAt: 'value'}}
function unflattenObject(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const parts = key.split('.');
    let current = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  return result;
}

// Get a document with service account auth
export async function saGetDocument(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  docId: string
): Promise<Record<string, unknown> | null> {
  const token = await getServiceAccountToken(serviceAccountKey);
  const url = getFirestoreUrl(projectId, `${collection}/${docId}`);

  const response = await fetchWithTimeout(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  }, 15000);

  if (response.status === 404) return null;

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get document: ${error}`);
  }

  const doc = await response.json() as Record<string, unknown>;

  // Convert to plain object
  const result: Record<string, unknown> = {};
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
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const token = await getServiceAccountToken(serviceAccountKey);
  const url = getFirestoreUrl(projectId, `${collection}/${docId}`);

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set document: ${error}`);
  }

  const doc = await response.json() as Record<string, unknown>;

  // Convert to plain object
  const result: Record<string, unknown> = {};
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
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const token = await getServiceAccountToken(serviceAccountKey);

  // Build update mask - escape field paths with special characters
  const updateMask = Object.keys(data)
    .map(key => `updateMask.fieldPaths=${encodeURIComponent(escapeFieldPath(key))}`)
    .join('&');
  const url = `${getFirestoreUrl(projectId, `${collection}/${docId}`)}?${updateMask}`;

  // Convert flat dotted keys to nested structure for Firestore
  const nestedData = unflattenObject(data);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nestedData)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update document: ${error}`);
  }

  const doc = await response.json() as Record<string, unknown>;

  const result: Record<string, unknown> = {};
  const docFields = doc.fields || {};
  for (const [key, value] of Object.entries(docFields)) {
    result[key] = fromFirestoreValue(value);
  }
  result.id = docId;

  return result;
}

// Delete a document with service account auth
export async function saDeleteDocument(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  docId: string
): Promise<void> {
  const token = await getServiceAccountToken(serviceAccountKey);
  const url = getFirestoreUrl(projectId, `${collection}/${docId}`);

  const response = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  }, 15000);

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    throw new Error(`Failed to delete document: ${error}`);
  }
}

// Add a document with auto-generated ID using service account auth
export async function saAddDocument(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  data: Record<string, unknown>
): Promise<{ id: string; data: Record<string, unknown> }> {
  const token = await getServiceAccountToken(serviceAccountKey);
  const url = getFirestoreUrl(projectId, collection);

  // Convert data to Firestore fields format
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to add document: ${response.status} - ${error}`);
  }

  const result = await response.json() as Record<string, unknown>;

  // Extract document ID from the name field (format: projects/.../documents/collection/docId)
  const nameParts = (result.name as string)?.split('/') || [];
  const docId = nameParts[nameParts.length - 1] || '';

  // Convert result fields back to plain object
  const resultData: Record<string, unknown> = {};
  const docFields = (result.fields || {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(docFields)) {
    resultData[key] = fromFirestoreValue(value);
  }

  return {
    id: docId,
    data: resultData
  };
}

// Query a collection with service account auth
export async function saQueryCollection(
  serviceAccountKey: string,
  projectId: string,
  collection: string,
  options?: {
    filters?: Array<{ field: string; op: string; value: unknown }>;
    orderBy?: { field: string; direction?: 'ASCENDING' | 'DESCENDING' };
    limit?: number;
  }
): Promise<Record<string, unknown>[]> {
  const token = await getServiceAccountToken(serviceAccountKey);

  // If we have filters, use structured query (POST)
  if (options?.filters && options.filters.length > 0) {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

    // Map operator strings to Firestore operators
    const opMap: Record<string, string> = {
      'EQUAL': 'EQUAL',
      '==': 'EQUAL',
      'NOT_EQUAL': 'NOT_EQUAL',
      '!=': 'NOT_EQUAL',
      'LESS_THAN': 'LESS_THAN',
      '<': 'LESS_THAN',
      'LESS_THAN_OR_EQUAL': 'LESS_THAN_OR_EQUAL',
      '<=': 'LESS_THAN_OR_EQUAL',
      'GREATER_THAN': 'GREATER_THAN',
      '>': 'GREATER_THAN',
      'GREATER_THAN_OR_EQUAL': 'GREATER_THAN_OR_EQUAL',
      '>=': 'GREATER_THAN_OR_EQUAL',
      'IN': 'IN',
      'NOT_IN': 'NOT_IN',
      'ARRAY_CONTAINS': 'ARRAY_CONTAINS',
      'ARRAY_CONTAINS_ANY': 'ARRAY_CONTAINS_ANY'
    };

    // Build composite filter for multiple filters
    const fieldFilters = options.filters.map(f => ({
      fieldFilter: {
        field: { fieldPath: f.field },
        op: opMap[f.op] || f.op,
        value: toFirestoreValue(f.value)
      }
    }));

    let where: Record<string, unknown>;
    if (fieldFilters.length === 1) {
      where = fieldFilters[0];
    } else {
      where = {
        compositeFilter: {
          op: 'AND',
          filters: fieldFilters
        }
      };
    }

    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: collection }],
      where
    };

    if (options?.orderBy) {
      structuredQuery.orderBy = [{
        field: { fieldPath: options.orderBy.field },
        direction: options.orderBy.direction || 'ASCENDING'
      }];
    }

    if (options?.limit) {
      structuredQuery.limit = options.limit;
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ structuredQuery })
    }, 15000);

    if (!response.ok) {
      const error = await response.text();
      log.error('[saQueryCollection] Structured query error:', error);
      return [];
    }

    const results = await response.json() as Record<string, unknown>[];
    return results
      .filter((r) => r.document) // Filter out empty results
      .map((r) => {
        const doc = r.document as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        const fields = (doc.fields || {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(fields)) {
          result[key] = fromFirestoreValue(value);
        }
        const nameParts = (doc.name as string).split('/');
        result.id = nameParts[nameParts.length - 1];
        return result;
      });
  }

  // No filters - use simple GET
  let url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}`;
  const params: string[] = [];

  if (options?.orderBy) {
    params.push(`orderBy=${options.orderBy.field}${options.orderBy.direction === 'DESCENDING' ? ' desc' : ''}`);
  }
  if (options?.limit) {
    params.push(`pageSize=${options.limit}`);
  }

  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  const response = await fetchWithTimeout(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('[saQueryCollection] Error:', error);
    return [];
  }

  const data = await response.json() as Record<string, unknown>;
  const documents = (data.documents || []) as Record<string, unknown>[];

  return documents.map((doc) => {
    const result: Record<string, unknown> = {};
    const fields = (doc.fields || {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      result[key] = fromFirestoreValue(value);
    }
    // Extract document ID from name
    const nameParts = (doc.name as string).split('/');
    result.id = nameParts[nameParts.length - 1];
    return result;
  });
}
