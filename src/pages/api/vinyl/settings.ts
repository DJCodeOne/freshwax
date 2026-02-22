// src/pages/api/vinyl/settings.ts
// Vinyl seller settings API - D1 Primary, Firebase backup
// Handles shipping costs, store info, etc.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { d1GetVinylSeller, d1UpsertVinylSeller, d1GetNextCollectionNumber } from '../../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { saSetDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const logger = createLogger('vinyl-settings');

const VinylSettingsSchema = z.object({
  userId: z.string().min(1).max(500),
  // UK Shipping
  shippingSingle: z.union([z.string().max(20), z.number()]).nullish(),
  shippingAdditional: z.union([z.string().max(20), z.number()]).nullish(),
  // International Shipping
  shipsInternational: z.boolean().nullish(),
  shippingEurope: z.union([z.string().max(20), z.number()]).nullish(),
  shippingEuropeAdditional: z.union([z.string().max(20), z.number()]).nullish(),
  shippingWorldwide: z.union([z.string().max(20), z.number()]).nullish(),
  shippingWorldwideAdditional: z.union([z.string().max(20), z.number()]).nullish(),
  // Delivery options
  deliveryMethod: z.string().max(100).nullish(),
  estimatedDelivery: z.string().max(50).nullish(),
  dispatchTime: z.string().max(50).nullish(),
  // Store Info
  storeName: z.string().max(50).nullish(),
  location: z.string().max(50).nullish(),
  description: z.string().max(500).nullish(),
  discogsUrl: z.string().max(200).nullish(),
  // Meta
  createdAt: z.string().max(100).nullish(),
}).passthrough();

export const prerender = false;

// Validation limits
const MAX_SHIPPING = 100; // £100 max
const MAX_STORE_NAME = 50;
const MAX_LOCATION = 50;
const MAX_DESCRIPTION = 500;

// GET - Fetch seller settings (D1 first, Firebase fallback)
export const GET: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    return ApiErrors.badRequest('User ID required');
  }

  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-settings-read:${clientId}`, {
    maxRequests: 60,
    windowMs: 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    let settings = null;
    let source = 'none';

    // Try D1 first (primary)
    const db = env.DB;
    if (db) {
      try {
        settings = await d1GetVinylSeller(db, userId);
        if (settings) {
          source = 'd1';
          logger.info('[vinyl/settings GET] Loaded from D1:', userId);
        }
      } catch (d1Error: unknown) {
        logger.error('[vinyl/settings GET] D1 error:', d1Error);
      }
    }

    // Fallback to Firebase if D1 failed or no data
    if (!settings) {
      try {
        settings = await getDocument('vinyl-sellers', userId);
        if (settings) {
          source = 'firebase';
          logger.info('[vinyl/settings GET] Loaded from Firebase:', userId);

          // Backfill to D1 if available
          if (db && settings) {
            try {
              await d1UpsertVinylSeller(db, userId, settings);
              logger.info('[vinyl/settings GET] Backfilled to D1:', userId);
            } catch (backfillError: unknown) {
              logger.error('[vinyl/settings GET] D1 backfill failed:', backfillError);
            }
          }
        }
      } catch (fbError: unknown) {
        logger.error('[vinyl/settings GET] Firebase error:', fbError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      settings: settings || null,
      source
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('[vinyl/settings GET] Error:', error);
    return ApiErrors.serverError('Failed to fetch settings');
  }
};

// POST - Save seller settings (D1 primary, Firebase backup)
export const POST: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};

  // Rate limit writes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-settings-write:${clientId}`, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();
    const parseResult = VinylSettingsSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const body = parseResult.data;
    const { userId } = body;

    // Verify user is updating their own settings
    if (verifiedUserId !== userId) {
      return ApiErrors.forbidden('You can only update your own settings');
    }

    // Validate and sanitize data
    const now = new Date().toISOString();
    const db = env.DB;

    // Check if user already has settings (to preserve collection number)
    let existingSettings = null;
    let collectionNumber = null;
    let isNewSeller = false;

    if (db) {
      try {
        existingSettings = await d1GetVinylSeller(db, userId);
        if (existingSettings?.collectionNumber) {
          collectionNumber = existingSettings.collectionNumber;
        } else {
          // New seller - assign next collection number
          collectionNumber = await d1GetNextCollectionNumber(db);
          isNewSeller = true;
          logger.info('[vinyl/settings POST] Assigning collection number:', collectionNumber);
        }
      } catch (e: unknown) {
        logger.error('[vinyl/settings POST] Error checking existing settings:', e);
      }
    }

    const settings: Record<string, unknown> = {
      userId,
      collectionNumber,
      // UK Shipping
      shippingSingle: Math.min(Math.max(parseFloat(body.shippingSingle) || 0, 0), MAX_SHIPPING),
      shippingAdditional: Math.min(Math.max(parseFloat(body.shippingAdditional) || 0, 0), MAX_SHIPPING),
      // International Shipping
      shipsInternational: !!body.shipsInternational,
      shippingEurope: Math.min(Math.max(parseFloat(body.shippingEurope) || 0, 0), MAX_SHIPPING),
      shippingEuropeAdditional: Math.min(Math.max(parseFloat(body.shippingEuropeAdditional) || 0, 0), MAX_SHIPPING),
      shippingWorldwide: Math.min(Math.max(parseFloat(body.shippingWorldwide) || 0, 0), MAX_SHIPPING),
      shippingWorldwideAdditional: Math.min(Math.max(parseFloat(body.shippingWorldwideAdditional) || 0, 0), MAX_SHIPPING),
      // Delivery options
      deliveryMethod: body.deliveryMethod || 'royal_mail_signed',
      estimatedDelivery: body.estimatedDelivery || '2-3',
      dispatchTime: body.dispatchTime || '1_day',
      // Store Info
      storeName: (body.storeName || '').trim().slice(0, MAX_STORE_NAME),
      location: (body.location || '').trim().slice(0, MAX_LOCATION),
      description: (body.description || '').trim().slice(0, MAX_DESCRIPTION),
      discogsUrl: (body.discogsUrl || '').trim().slice(0, 200),
      // Meta
      updatedAt: now,
      createdAt: existingSettings?.createdAt || body.createdAt || now
    };

    let d1Success = false;
    let firebaseSuccess = false;

    // Write to D1 first (primary)
    if (db) {
      try {
        d1Success = await d1UpsertVinylSeller(db, userId, settings);
        if (d1Success) {
          logger.info('[vinyl/settings POST] Saved to D1:', userId);
        }
      } catch (d1Error: unknown) {
        logger.error('[vinyl/settings POST] D1 error:', d1Error);
      }
    }

    // Write to Firebase as backup (non-blocking failure)
    try {
      const serviceAccountKey = getServiceAccountKey(env);
      const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

      if (serviceAccountKey) {
        await saSetDocument(serviceAccountKey, projectId, 'vinyl-sellers', userId, settings);
        firebaseSuccess = true;
        logger.info('[vinyl/settings POST] Saved to Firebase:', userId);
      } else {
        // Try client API as fallback
        await setDocument('vinyl-sellers', userId, settings);
        firebaseSuccess = true;
        logger.info('[vinyl/settings POST] Saved to Firebase (client API):', userId);
      }
    } catch (fbError: unknown) {
      logger.error('[vinyl/settings POST] Firebase backup failed (non-critical):', fbError);
    }

    // At least one storage must succeed
    if (!d1Success && !firebaseSuccess) {
      return ApiErrors.serverError('Failed to save settings');
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Settings saved',
      collectionNumber: collectionNumber,
      isNewSeller: isNewSeller,
      storage: { d1: d1Success, firebase: firebaseSuccess }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('[vinyl/settings POST] Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
