// src/pages/api/admin/add-artist.ts
// Manually add an artist to the artists collection
import type { APIRoute } from 'astro';
import { z } from 'zod';

import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/add-artist');

const addArtistSchema = z.object({
  userId: z.string().min(1),
  artistName: z.string().min(1),
  email: z.string().email().optional(),
  bio: z.string().optional(),
  links: z.string().optional(),
  isArtist: z.boolean().optional(),
  isDJ: z.boolean().optional(),
  isMerchSupplier: z.boolean().optional(),
  adminKey: z.string().optional(),
});

export const prerender = false;

// Convert value to Firestore format
function toFirestoreValue(value: unknown): Record<string, unknown> {
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
    const mapFields: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      mapFields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields: mapFields } };
  }
  return { stringValue: String(value) };
}

// Direct Firestore write (bypasses SDK restrictions)
async function writeToFirestore(collection: string, docId: string, data: Record<string, unknown>) {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const apiKey = import.meta.env.PUBLIC_FIREBASE_API_KEY;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;

  const fields: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  }, 10000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Firestore error: ${response.status} - ${error}`);
  }

  return response.json();
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`add-artist:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json();
    const env = locals.runtime.env;
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = addArtistSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { userId, artistName, email, bio, links, isArtist, isDJ, isMerchSupplier } = parsed.data;

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

    return successResponse({ message: `Added ${artistName} to artists and users collections`,
      artistId: userId });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to add artist');
  }
};
