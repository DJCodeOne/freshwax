// src/pages/api/admin/add-artist.ts
// Manually add an artist to the artists collection
import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

const ADMIN_KEY = import.meta.env.ADMIN_KEY || 'freshwax-admin-2024';

// Convert value to Firestore format
function toFirestoreValue(value: any): any {
  if (value === null || value === undefined) {
    return { nullValue: null };
  } else if (typeof value === 'string') {
    return { stringValue: value };
  } else if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  } else if (typeof value === 'boolean') {
    return { booleanValue: value };
  } else if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  } else if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(v => toFirestoreValue(v)) } };
  } else if (typeof value === 'object') {
    const mapFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      mapFields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields: mapFields } };
  }
  return { stringValue: String(value) };
}

// Direct Firestore write (bypasses SDK restrictions)
async function writeToFirestore(collection: string, docId: string, data: Record<string, any>) {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const apiKey = import.meta.env.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Firestore error: ${response.status} - ${error}`);
  }

  return response.json();
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { adminKey, userId, artistName, email, bio, links, isArtist, isDJ, isMerchSupplier } = body;

    // Verify admin key
    if (adminKey !== ADMIN_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid admin key' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!userId || !artistName) {
      return new Response(JSON.stringify({ success: false, error: 'userId and artistName are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create artist document
    const artistData = {
      id: userId,
      userId: userId,
      artistName: artistName,
      name: artistName,
      displayName: artistName,
      email: email || '',
      bio: bio || '',
      links: links || '',
      isArtist: isArtist !== false,
      isDJ: isDJ || false,
      isMerchSupplier: isMerchSupplier || false,
      approved: true,
      suspended: false,
      approvedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await writeToFirestore('artists', userId, artistData);

    // Also update users collection with roles
    const userRoles = {
      customer: true,
      dj: isDJ || false,
      artist: isArtist !== false,
      merchSupplier: isMerchSupplier || false
    };

    await writeToFirestore('users', userId, {
      roles: userRoles,
      partnerInfo: {
        approved: true,
        displayName: artistName
      },
      updatedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Added ${artistName} to artists and users collections`,
      artistId: userId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[add-artist] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add artist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
