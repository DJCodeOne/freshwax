// src/lib/firebase/transforms.ts
// Atomic Firestore operations: atomicIncrement, updateDocumentConditional, arrayUnion, arrayRemove

import { fetchWithTimeout } from '../api-utils';
import { TIMEOUTS } from '../timeouts';
import {
  log,
  PROJECT_ID,
  cache,
  getAuthHeaders,
  getEnvVar,
  toFirestoreValue,
} from './core';
import { clearCache } from './cache';

const FIREBASE_429_RETRY_DELAY = TIMEOUTS.FIREBASE_RATE_LIMIT_RETRY;

/**
 * Atomically increment numeric fields using Firestore's commit API with fieldTransforms.
 * Unlike incrementField, this does NOT do read-modify-write and is safe against race conditions.
 * @param collection - Firestore collection
 * @param docId - Document ID
 * @param increments - Map of field paths to increment values (negative for decrement)
 */
export async function atomicIncrement(
  collection: string,
  docId: string,
  increments: Record<string, number>
): Promise<{ success: boolean; newValues: Record<string, number> }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const fields = Object.keys(increments);
  const fieldTransforms = Object.entries(increments).map(([field, value]) => ({
    fieldPath: field,
    increment: Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value }
  }));

  const atomicHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const commitBody = JSON.stringify({
    writes: [{
      transform: {
        document: documentPath,
        fieldTransforms
      }
    }]
  });
  let response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: atomicHeaders,
    body: commitBody
  }, 15000);

  // Single retry after 1s delay for rate limiting (429 RESOURCE_EXHAUSTED)
  if (!response.ok && response.status === 429) {
    log.warn(`atomicIncrement ${collection}/${docId} got 429 (rate limited), retrying in ${FIREBASE_429_RETRY_DELAY}ms...`);
    await new Promise(resolve => setTimeout(resolve, FIREBASE_429_RETRY_DELAY));
    response = await fetchWithTimeout(commitUrl, {
      method: 'POST',
      headers: atomicHeaders,
      body: commitBody
    }, 15000);
  }

  if (!response.ok) {
    const error = await response.text();
    log.error('atomicIncrement error:', error);
    throw new Error(`Atomic increment failed: ${response.status}`);
  }

  // Parse transform results to get new values
  const newValues: Record<string, number> = {};
  try {
    const result = await response.json();
    const transformResults = result?.writeResults?.[0]?.transformResults || [];
    for (let i = 0; i < fields.length && i < transformResults.length; i++) {
      const tr = transformResults[i];
      newValues[fields[i]] = Number(tr.integerValue ?? tr.doubleValue ?? 0);
    }
  } catch (_e: unknown) {
    /* intentional: JSON parse failure returns empty newValues — callers handle gracefully */
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true, newValues };
}

/**
 * Update a document only if it hasn't been modified since expectedUpdateTime.
 * Uses Firestore's commit API with currentDocument precondition for optimistic concurrency.
 * Throws an error containing 'CONFLICT' if the document was modified by another request.
 */
export async function updateDocumentConditional(
  collection: string,
  docId: string,
  data: Record<string, unknown>,
  expectedUpdateTime: string
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const conditionalHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const conditionalBody = JSON.stringify({
    writes: [{
      update: {
        name: documentPath,
        fields
      },
      updateMask: {
        fieldPaths: Object.keys(data)
      },
      currentDocument: {
        updateTime: expectedUpdateTime
      }
    }]
  });
  let response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: conditionalHeaders,
    body: conditionalBody
  }, 15000);

  // Single retry after 1s delay for rate limiting (429 RESOURCE_EXHAUSTED)
  if (!response.ok && response.status === 429) {
    log.warn(`updateDocumentConditional ${collection}/${docId} got 429 (rate limited), retrying in ${FIREBASE_429_RETRY_DELAY}ms...`);
    await new Promise(resolve => setTimeout(resolve, FIREBASE_429_RETRY_DELAY));
    response = await fetchWithTimeout(commitUrl, {
      method: 'POST',
      headers: conditionalHeaders,
      body: conditionalBody
    }, 15000);
  }

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 409 || error.includes('FAILED_PRECONDITION')) {
      throw new Error('CONFLICT: Document was modified by another request');
    }
    log.error('updateDocumentConditional error:', error);
    throw new Error(`Conditional update failed: ${response.status}`);
  }

  // Invalidate cache
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true };
}

/**
 * Atomically append elements to an array field using Firestore's commit API with fieldTransforms.
 * Uses appendMissingElements (Firestore's arrayUnion) so concurrent appends never lose data.
 * Unlike the old read-modify-write approach, this is safe against race conditions.
 *
 * Note: appendMissingElements deduplicates by value. Since each element includes a unique `id`
 * and `createdAt`/`timestamp`, duplicates are effectively impossible for comments/transactions.
 *
 * @param collection - Firestore collection
 * @param docId - Document ID
 * @param fieldName - The array field to append to
 * @param values - Array of values to append
 * @param additionalFields - Optional additional fields to update on the same document (e.g. commentCount, lastUpdated)
 */
export async function arrayUnion(
  collection: string,
  docId: string,
  fieldName: string,
  values: unknown[],
  additionalFields?: Record<string, unknown>
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const writes: Record<string, unknown>[] = [];

  // Write 1: Field transform to atomically append to the array
  writes.push({
    transform: {
      document: documentPath,
      fieldTransforms: [{
        fieldPath: fieldName,
        appendMissingElements: {
          values: values.map(v => toFirestoreValue(v))
        }
      }]
    }
  });

  // Write 2: If there are additional fields to update (e.g. updatedAt, commentCount), add a separate update write
  if (additionalFields && Object.keys(additionalFields).length > 0) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(additionalFields)) {
      fields[key] = toFirestoreValue(value);
    }
    writes.push({
      update: {
        name: documentPath,
        fields
      },
      updateMask: {
        fieldPaths: Object.keys(additionalFields)
      }
    });
  }

  const arrayUnionHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const arrayUnionBody = JSON.stringify({ writes });
  let response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: arrayUnionHeaders,
    body: arrayUnionBody
  }, 15000);

  // Single retry after 1s delay for rate limiting (429 RESOURCE_EXHAUSTED)
  if (!response.ok && response.status === 429) {
    log.warn(`arrayUnion ${collection}/${docId} got 429 (rate limited), retrying in ${FIREBASE_429_RETRY_DELAY}ms...`);
    await new Promise(resolve => setTimeout(resolve, FIREBASE_429_RETRY_DELAY));
    response = await fetchWithTimeout(commitUrl, {
      method: 'POST',
      headers: arrayUnionHeaders,
      body: arrayUnionBody
    }, 15000);
  }

  if (!response.ok) {
    const error = await response.text();
    log.error('arrayUnion error:', error);
    throw new Error(`Atomic arrayUnion failed: ${response.status}`);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true };
}

/**
 * Atomically removes values from an array field in a Firestore document.
 * Uses Firestore's removeAllFromArray transform to avoid race conditions.
 * @param collection - The Firestore collection
 * @param docId - The document ID
 * @param fieldName - The array field to remove from
 * @param values - Array of values to remove
 * @param additionalFields - Optional additional fields to update on the same document (e.g. updatedAt)
 */
export async function arrayRemove(
  collection: string,
  docId: string,
  fieldName: string,
  values: unknown[],
  additionalFields?: Record<string, unknown>
): Promise<{ success: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit?key=${apiKey}`;
  const documentPath = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

  const writes: Record<string, unknown>[] = [];

  // Write 1: Field transform to atomically remove from the array
  writes.push({
    transform: {
      document: documentPath,
      fieldTransforms: [{
        fieldPath: fieldName,
        removeAllFromArray: {
          values: values.map(v => toFirestoreValue(v))
        }
      }]
    }
  });

  // Write 2: If there are additional fields to update (e.g. updatedAt), add a separate update write
  if (additionalFields && Object.keys(additionalFields).length > 0) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(additionalFields)) {
      fields[key] = toFirestoreValue(value);
    }
    writes.push({
      update: {
        name: documentPath,
        fields
      },
      updateMask: {
        fieldPaths: Object.keys(additionalFields)
      }
    });
  }

  const arrayRemoveHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const arrayRemoveBody = JSON.stringify({ writes });
  let response = await fetchWithTimeout(commitUrl, {
    method: 'POST',
    headers: arrayRemoveHeaders,
    body: arrayRemoveBody
  }, 15000);

  // Single retry after 1s delay for rate limiting (429 RESOURCE_EXHAUSTED)
  if (!response.ok && response.status === 429) {
    log.warn(`arrayRemove ${collection}/${docId} got 429 (rate limited), retrying in ${FIREBASE_429_RETRY_DELAY}ms...`);
    await new Promise(resolve => setTimeout(resolve, FIREBASE_429_RETRY_DELAY));
    response = await fetchWithTimeout(commitUrl, {
      method: 'POST',
      headers: arrayRemoveHeaders,
      body: arrayRemoveBody
    }, 15000);
  }

  if (!response.ok) {
    const error = await response.text();
    log.error('arrayRemove error:', error);
    throw new Error(`Atomic arrayRemove failed: ${response.status}`);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true };
}
