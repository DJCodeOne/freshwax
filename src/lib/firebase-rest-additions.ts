// ============================================
// ADD THESE FUNCTIONS TO YOUR EXISTING
// src/lib/firebase-rest.ts FILE
// ============================================

/**
 * Set/Create a document in Firestore
 * Creates or overwrites a document at the specified path
 */
export async function setDocument(
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<{ success: boolean; id: string }> {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = import.meta.env.FIREBASE_API_KEY;
  
  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  // Convert JS object to Firestore format
  const fields: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(data)) {
    fields[key] = convertToFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Firestore setDocument error:', error);
    throw new Error(`Failed to set document: ${response.status}`);
  }

  return { success: true, id: docId };
}

/**
 * Delete a document from Firestore
 */
export async function deleteDocument(
  collection: string,
  docId: string
): Promise<{ success: boolean }> {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = import.meta.env.FIREBASE_API_KEY;
  
  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    }
  });

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    console.error('Firestore deleteDocument error:', error);
    throw new Error(`Failed to delete document: ${response.status}`);
  }

  return { success: true };
}

/**
 * Update specific fields in a document (partial update)
 */
export async function updateDocument(
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<{ success: boolean }> {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = import.meta.env.FIREBASE_API_KEY;
  
  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  // Build update mask for partial updates
  const updateMask = Object.keys(data).map(key => `updateMask.fieldPaths=${key}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?${updateMask}&key=${apiKey}`;

  // Convert JS object to Firestore format
  const fields: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(data)) {
    fields[key] = convertToFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Firestore updateDocument error:', error);
    throw new Error(`Failed to update document: ${response.status}`);
  }

  return { success: true };
}

/**
 * Helper: Convert JavaScript value to Firestore value format
 * (You may already have this function - if so, skip it)
 */
function convertToFirestoreValue(value: any): any {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(v => convertToFirestoreValue(v))
      }
    };
  }
  
  if (typeof value === 'object') {
    const mapFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      mapFields[k] = convertToFirestoreValue(v);
    }
    return { mapValue: { fields: mapFields } };
  }
  
  return { stringValue: String(value) };
}
