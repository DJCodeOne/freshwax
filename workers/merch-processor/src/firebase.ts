// firebase.ts - Firebase REST API for merch processor

import type { Env, ProcessedMerch } from './types';

/**
 * Create or update a merch product document in Firebase using REST API
 */
export async function createMerchInFirebase(product: ProcessedMerch, env: Env): Promise<void> {
  const projectId = env.FIREBASE_PROJECT_ID;
  const apiKey = env.FIREBASE_API_KEY;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/merch/${product.id}?key=${apiKey}`;

  // Convert product object to Firestore document format
  const fields: Record<string, any> = {};

  for (const [key, value] of Object.entries(product)) {
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
      // Handle arrays (images, tags, sizes, colors, variants)
      if (value.length === 0) {
        fields[key] = { arrayValue: { values: [] } };
      } else if (typeof value[0] === 'string') {
        fields[key] = {
          arrayValue: {
            values: value.map(v => ({ stringValue: v }))
          }
        };
      } else if (typeof value[0] === 'object') {
        // Handle array of objects (variants)
        fields[key] = {
          arrayValue: {
            values: value.map(v => {
              const mapFields: Record<string, any> = {};
              for (const [k, val] of Object.entries(v)) {
                if (typeof val === 'string') {
                  mapFields[k] = { stringValue: val };
                } else if (typeof val === 'number') {
                  if (Number.isInteger(val)) {
                    mapFields[k] = { integerValue: val.toString() };
                  } else {
                    mapFields[k] = { doubleValue: val };
                  }
                } else if (typeof val === 'boolean') {
                  mapFields[k] = { booleanValue: val };
                }
              }
              return { mapValue: { fields: mapFields } };
            })
          }
        };
      }
    } else if (typeof value === 'object') {
      // Handle nested objects (dimensions)
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

  console.log(`[Firebase] Merch created/updated: ${product.id}`);
}
