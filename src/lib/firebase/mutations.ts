// src/lib/firebase/mutations.ts
// CRUD write operations: setDocument, createDocumentIfNotExists, updateDocument, deleteDocument, addDocument

import { fetchWithTimeout } from '../api-utils';
import {
  log,
  PROJECT_ID,
  FIREBASE_API_KEY_FALLBACK,
  cache,
  getAuthHeaders,
  getEnvVar,
  toFirestoreValue,
  validatePath,
} from './core';
import { clearCache } from './cache';

export async function setDocument(
  collection: string,
  docId: string,
  data: Record<string, unknown>,
  idToken?: string
): Promise<{ success: boolean; id: string }> {
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || FIREBASE_API_KEY_FALLBACK;

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const errorText = await response.text();
    log.error('setDocument error:', response.status, errorText);
    let errorMessage = `Failed to set document: ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorJson.error?.status || errorMessage;
    } catch (e: unknown) {
      // Use raw text if not JSON
      if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
    }
    throw new Error(errorMessage);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true, id: docId };
}

// Create document only if it doesn't exist (returns false if already exists)
export async function createDocumentIfNotExists(
  collection: string,
  docId: string,
  data: Record<string, unknown>
): Promise<{ success: boolean; exists: boolean }> {
  const projectId = getEnvVar('FIREBASE_PROJECT_ID') || PROJECT_ID;
  const apiKey = getEnvVar('FIREBASE_API_KEY') || getEnvVar('PUBLIC_FIREBASE_API_KEY') || FIREBASE_API_KEY_FALLBACK;

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  // Use currentDocument.exists=false to only create if doesn't exist
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?currentDocument.exists=false&key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const cdinHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: cdinHeaders,
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const errorText = await response.text();
    // Check if it's a "document already exists" error
    if (response.status === 400 && errorText.includes('ALREADY_EXISTS')) {
      return { success: false, exists: true };
    }
    // Also check for precondition failed (409) which Firebase may return
    if (response.status === 409 || errorText.includes('FAILED_PRECONDITION')) {
      return { success: false, exists: true };
    }
    log.error('createDocumentIfNotExists error:', response.status, errorText);
    throw new Error(`Failed to create document: ${response.status}`);
  }

  // Invalidate cache for this document
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true, exists: false };
}

export async function updateDocument(
  collection: string,
  docId: string,
  data: Record<string, unknown>,
  idToken?: string
): Promise<{ success: boolean }> {
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  // Build updateMask for Firestore REST API
  // Dots indicate nested field paths (e.g., roles.artist) - pass these as-is
  // Backticks are only for field names with special chars like hyphens in a segment
  const updateMask = Object.keys(data).map(key => {
    // Check each segment of the field path
    const segments = key.split('.');
    const quotedSegments = segments.map(segment => {
      // Only quote if segment has special characters (not just alphanumeric/underscore)
      return /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(segment) ? segment : `\`${segment}\``;
    });
    const quotedKey = quotedSegments.join('.');
    return `updateMask.fieldPaths=${encodeURIComponent(quotedKey)}`;
  }).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?${updateMask}&key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('updateDocument error:', response.status, error);
    log.error('updateDocument collection:', collection, 'docId:', docId);
    log.error('updateDocument had token:', !!idToken);
    throw new Error(`Failed to update document: ${response.status} - ${error}`);
  }

  // Invalidate cache
  cache.delete(`doc:${collection}:${docId}`);

  return { success: true };
}

export async function deleteDocument(
  collection: string,
  docId: string,
  idToken?: string
): Promise<{ success: boolean }> {
  validatePath(collection, 'collection');
  validatePath(docId, 'docId');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing - ensure initFirebaseEnv() is called');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers
  }, 15000);

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    log.error('deleteDocument error:', error);
    throw new Error(`Failed to delete document: ${response.status}`);
  }

  // Invalidate cache
  cache.delete(`doc:${collection}:${docId}`);
  clearCache(`query:${collection}`);

  return { success: true };
}

// Add a document with auto-generated ID
// idToken is optional - if provided, request is authenticated
export async function addDocument(
  collection: string,
  data: Record<string, unknown>,
  idToken?: string
): Promise<{ success: boolean; id: string }> {
  validatePath(collection, 'collection');
  const projectId = getEnvVar('FIREBASE_PROJECT_ID', PROJECT_ID);
  const apiKey = getEnvVar('FIREBASE_API_KEY');

  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?key=${apiKey}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    Object.assign(headers, await getAuthHeaders());
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields })
  }, 15000);

  if (!response.ok) {
    const error = await response.text();
    log.error('addDocument error:', error);
    throw new Error(`Failed to add document: ${response.status}`);
  }

  const result = await response.json();
  // Extract ID from name path like "projects/.../documents/collection/docId"
  const docId = result.name.split('/').pop();

  // Clear collection query cache
  clearCache(`query:${collection}`);

  return { success: true, id: docId };
}
