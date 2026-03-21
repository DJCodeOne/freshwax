// src/pages/api/artist/update-shipping.ts
// Update artist's default vinyl shipping rates
// Uses service account for writes to ensure Firebase security rules don't block

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { saUpdateDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors, successResponse } from '../../../lib/api-utils';

const log = createLogger('artist/update-shipping');

const UpdateShippingSchema = z.object({
  artistId: z.string().min(1).max(500),
  vinylShippingUK: z.union([z.string().max(20), z.number().min(0).max(1000)]).nullish(),
  vinylShippingEU: z.union([z.string().max(20), z.number().min(0).max(1000)]).nullish(),
  vinylShippingIntl: z.union([z.string().max(20), z.number().min(0).max(1000)]).nullish(),
  vinylShipsFrom: z.string().max(200).nullish(),
}).strip();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-shipping:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  try {
    // SECURITY: Verify user authentication
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();
    const parseResult = UpdateShippingSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { artistId, vinylShippingUK, vinylShippingEU, vinylShippingIntl, vinylShipsFrom } = parseResult.data;

    // Verify the authenticated user matches the artistId
    if (verifiedUserId !== artistId) {
      return ApiErrors.forbidden('You can only update your own shipping rates');
    }

    // Validate shipping rates (must be non-negative if provided)
    const validateRate = (rate: string | number | null | undefined, name: string) => {
      if (rate !== null && rate !== undefined) {
        const num = parseFloat(rate);
        if (isNaN(num) || num < 0) {
          throw new Error(`Invalid ${name} rate`);
        }
        return num;
      }
      return null;
    };

    const shippingUK = validateRate(vinylShippingUK, 'UK');
    const shippingEU = validateRate(vinylShippingEU, 'EU');
    const shippingIntl = validateRate(vinylShippingIntl, 'International');

    // Verify artist exists
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return ApiErrors.notFound('Artist not found');
    }

    // Build update object (only include non-null values)
    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString()
    };

    // Update or remove shipping rates
    if (shippingUK !== null) {
      updateData.vinylShippingUK = shippingUK;
    }
    if (shippingEU !== null) {
      updateData.vinylShippingEU = shippingEU;
    }
    if (shippingIntl !== null) {
      updateData.vinylShippingIntl = shippingIntl;
    }
    if (vinylShipsFrom) {
      updateData.vinylShipsFrom = vinylShipsFrom.trim();
    }

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      log.error('Service account not configured');
      return ApiErrors.serverError('Service account not configured');
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'artists', artistId, updateData);

    log.info('Updated shipping rates for:', artistId, updateData);

    return successResponse({ message: 'Shipping rates updated',
      data: {
        vinylShippingUK: shippingUK,
        vinylShippingEU: shippingEU,
        vinylShippingIntl: shippingIntl,
        vinylShipsFrom: vinylShipsFrom || null
      } });

  } catch (error: unknown) {
    log.error('Update shipping error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update shipping rates');
  }
};
