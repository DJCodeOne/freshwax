// firebase.ts - Firebase REST API for mix processor

import type { Env, ProcessedMix } from './types';

/**
 * Create or update a DJ mix document in Firebase using REST API
 */
export async function createMixInFirebase(mix: ProcessedMix, env: Env): Promise<void> {
  const projectId = env.FIREBASE_PROJECT_ID;
  const apiKey = env.FIREBASE_API_KEY;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/dj-mixes/${mix.id}?key=${apiKey}`;

  // Convert mix object to Firestore document format
  const fields: Record<string, any> = {};

  for (const [key, value] of Object.entries(mix)) {
    if (value === undefined || value === null) continue;

    if (typeof value === 'string') {
      fields[key] = { stringValue: value };
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        fields[key] = { integerValue: value.toString() };
      } else {
        fields[key] = { doubleValue: value };
      }
    } else if (typeof value === 'boolean') {
      fields[key] = { booleanValue: value };
    } else if (Array.isArray(value)) {
      fields[key] = {
        arrayValue: {
          values: value.map(v => {
            if (typeof v === 'string') return { stringValue: v };
            if (typeof v === 'number') return { integerValue: v.toString() };
            return { stringValue: String(v) };
          })
        }
      };
    } else if (typeof value === 'object') {
      // Handle nested objects like ratings
      const mapFields: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'string') {
          mapFields[k] = { stringValue: v };
        } else if (typeof v === 'number') {
          if (Number.isInteger(v)) {
            mapFields[k] = { integerValue: v.toString() };
          } else {
            mapFields[k] = { doubleValue: v };
          }
        } else if (typeof v === 'boolean') {
          mapFields[k] = { booleanValue: v };
        }
      }
      fields[key] = { mapValue: { fields: mapFields } };
    }
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Firebase error: ${response.status} - ${error}`);
  }

  console.log(`[Firebase] Mix created/updated: ${mix.id}`);
}
