// src/pages/api/livestream/update-slot-title.ts
// Update livestream slot title (for relay streams)

import type { APIRoute } from 'astro';
import { saUpdateDocument, getServiceAccountToken } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('livestream/update-slot-title');

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return result === 0;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-slot-title:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const data = await request.json();
    const { slotId, title, startTime, endTime, adminKey } = data;

    // Require admin key for security (timing-safe comparison)
    const expectedAdminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
    if (!adminKey || !expectedAdminKey || !timingSafeEqual(adminKey, expectedAdminKey)) {
      return ApiErrors.unauthorized('Unauthorized');
    }

    if (!slotId) {
      return ApiErrors.badRequest('slotId is required');
    }

    // Build service account key from env vars
    const serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
      private_key_id: 'auto',
      private_key: (env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      client_email: env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
      client_id: '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    });

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    // Build update object with provided fields
    const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (title) updateData.title = title;
    if (startTime) updateData.startTime = startTime;
    if (endTime) updateData.endTime = endTime;

    // Update the slot
    await saUpdateDocument(serviceAccountKey, projectId, 'livestreamSlots', slotId, updateData);

    return successResponse({ message: 'Slot updated successfully',
      updated: updateData });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update title');
  }
};
