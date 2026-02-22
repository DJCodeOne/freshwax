// src/pages/api/update-partner.ts
// API endpoint to update partner/artist profile and settings
// Uses service account for writes to ensure Firebase security rules don't block

import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { saUpdateDocument, getServiceAccountKey } from '../../lib/firebase-service-account';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('update-partner');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { z } from 'zod';

const UpdatePartnerSchema = z.object({
  id: z.string().min(1).max(200),
  artistName: z.string().max(50).nullish(),
  bio: z.string().max(200).nullish(),
  avatarUrl: z.string().max(2000).nullish(),
  bannerUrl: z.string().max(2000).nullish(),
  location: z.string().max(200).nullish(),
  genres: z.array(z.string().max(100)).max(20).nullish(),
}).passthrough();

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-partner:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Get runtime env
    const env = locals.runtime.env || {};

    // SECURITY: Verify Firebase token instead of trusting cookies
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = UpdatePartnerSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const { id, ...updateFields } = data;
    const partnerId = verifiedUserId;

    if (id !== partnerId) {
      return ApiErrors.forbidden('Not authorized to update this profile');
    }
    
    // Get partner document
    const partnerData = await getDocument('artists', partnerId);

    if (!partnerData) {
      return ApiErrors.notFound('Partner not found');
    }
    
    // Build clean update object (only allowed fields)
    const allowedFields = [
      'artistName', 'bio',
      'avatarUrl', 'bannerUrl', 'location', 'genres'
    ];
    
    const cleanData: Record<string, unknown> = {
      updatedAt: new Date().toISOString()
    };
    
    for (const field of allowedFields) {
      if (updateFields[field] !== undefined) {
        cleanData[field] = updateFields[field];
      }
    }
    
    // Validate specific fields
    if (cleanData.bio && cleanData.bio.length > 200) {
      cleanData.bio = cleanData.bio.slice(0, 200);
    }
    
    if (cleanData.artistName && cleanData.artistName.length > 50) {
      cleanData.artistName = cleanData.artistName.slice(0, 50);
    }

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      log.error('[update-partner] Service account not configured');
      return ApiErrors.serverError('Service account not configured');
    }

    // Use service account for the write operation
    await saUpdateDocument(serviceAccountKey, projectId, 'artists', partnerId, cleanData);

    return successResponse({ message: 'Profile updated successfully' });
    
  } catch (error: unknown) {
    log.error('Error updating partner:', error);
    return ApiErrors.serverError('Failed to update profile');
  }
};
