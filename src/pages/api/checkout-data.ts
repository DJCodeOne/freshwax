// src/pages/api/checkout-data.ts
// Lightweight API for checkout page to load/save customer data without Firestore SDK
// GET: Load customer profile data (address, name, etc.)
// POST: Save customer details for faster future checkout
// Note: initFirebaseEnv is called by middleware, no need to call it here

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('checkout-data');

// Zod schema for checkout data save
const CheckoutDataSchema = z.object({
  firstName: z.string().max(200).optional(),
  lastName: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(200).optional(),
  address1: z.string().max(200).optional(),
  address2: z.string().max(200).optional(),
  city: z.string().max(200).optional(),
  county: z.string().max(200).optional(),
  postcode: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
}).strict();

export const prerender = false;

// GET: Load customer data for checkout form pre-fill
export const GET: APIRoute = async ({ request }) => {
  try {
    const { userId, email, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const userDoc = await getDocument('users', userId);

    if (!userDoc) {
      return successResponse({ customer: null, email: email || null }, 200, {
        headers: { 'Cache-Control': 'private, no-store' }
      });
    }

    // Return only fields needed for checkout form pre-fill
    return successResponse({
      customer: {
        firstName: userDoc.firstName || userDoc.name?.split(' ')[0] || '',
        lastName: userDoc.lastName || userDoc.name?.split(' ').slice(1).join(' ') || '',
        email: userDoc.email || email || '',
        phone: userDoc.phone || '',
        address1: userDoc.address1 || userDoc.addressLine1 || '',
        address2: userDoc.address2 || userDoc.addressLine2 || '',
        city: userDoc.city || '',
        county: userDoc.county || '',
        postcode: userDoc.postcode || '',
        country: userDoc.country || 'United Kingdom'
      }
    }, 200, {
      headers: { 'Cache-Control': 'private, no-store' }
    });

  } catch (error: unknown) {
    log.error('[checkout-data] GET error:', error);
    return ApiErrors.serverError('Failed to load customer data');
  }
};

// POST: Save customer details for future checkouts
export const POST: APIRoute = async ({ request }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`checkout-data:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const rawBody = await request.json();

    // Zod input validation - only allows known fields via strict mode
    const parseResult = CheckoutDataSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(parseResult.data)) {
      if (value !== undefined) {
        sanitized[key] = String(value);
      }
    }
    sanitized.updatedAt = new Date().toISOString();

    // Merge with existing user document
    const existingDoc = await getDocument('users', userId);
    await setDocument('users', userId, {
      ...(existingDoc || {}),
      ...sanitized
    });

    return successResponse({} as Record<string, unknown>);

  } catch (error: unknown) {
    log.error('[checkout-data] POST error:', error);
    return ApiErrors.serverError('Failed to save customer data');
  }
};
