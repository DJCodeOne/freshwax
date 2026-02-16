// src/pages/api/user-profile.ts
// Lightweight API for dashboard to load/save user profile data without Firestore SDK
// GET: Load full user profile data (all fields from users collection)
// POST: Save profile form data (merge with existing document)
// Note: initFirebaseEnv is called by middleware, no need to call it here

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors } from '../../lib/api-utils';

const UserProfileUpdateSchema = z.object({
  firstName: z.string().max(200).optional(),
  lastName: z.string().max(200).optional(),
  fullName: z.string().max(200).optional(),
  displayName: z.string().max(200).optional(),
  displayNameLower: z.string().max(200).optional(),
  phone: z.string().max(200).optional(),
  address1: z.string().max(200).optional(),
  address2: z.string().max(200).optional(),
  city: z.string().max(200).optional(),
  county: z.string().max(200).optional(),
  postcode: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
}).catchall(z.unknown());

export const prerender = false;

// GET: Load full user profile data for dashboard
export const GET: APIRoute = async ({ request }) => {
  try {
    const { userId, email, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const userDoc = await getDocument('users', userId);

    if (!userDoc) {
      return new Response(JSON.stringify({
        success: true,
        profile: null,
        email: email || null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Return all profile-relevant fields (dashboard needs more than checkout)
    return new Response(JSON.stringify({
      success: true,
      profile: {
        firstName: userDoc.firstName || '',
        lastName: userDoc.lastName || '',
        fullName: userDoc.fullName || '',
        displayName: userDoc.displayName || userDoc.fullName || userDoc.firstName || '',
        email: userDoc.email || email || '',
        phone: userDoc.phone || '',
        address1: userDoc.address1 || userDoc.addressLine1 || '',
        address2: userDoc.address2 || userDoc.addressLine2 || '',
        city: userDoc.city || '',
        county: userDoc.county || '',
        postcode: userDoc.postcode || '',
        country: userDoc.country || 'United Kingdom',
        isPro: userDoc.isPro || userDoc.isArtist || userDoc.approved || false,
        avatarUrl: userDoc.avatarUrl || userDoc.photoURL || null,
        name: userDoc.name || ''
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[user-profile] GET error:', error);
    return ApiErrors.serverError('Failed to load user profile');
  }
};

// POST: Save profile form data (merge with existing document)
export const POST: APIRoute = async ({ request }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`user-profile:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const body = await request.json();
    const parsed = UserProfileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    // Validate and sanitize input - only allow known profile fields
    const allowedFields = [
      'firstName', 'lastName', 'fullName', 'displayName', 'displayNameLower',
      'phone', 'address1', 'address2', 'city', 'county', 'postcode', 'country'
    ];
    const sanitized: Record<string, string> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        sanitized[field] = String(body[field]).slice(0, 200); // Limit field length
      }
    }
    sanitized.updatedAt = new Date().toISOString();

    // Merge with existing user document (equivalent to setDoc with merge: true)
    const existingDoc = await getDocument('users', userId);
    await setDocument('users', userId, {
      ...(existingDoc || {}),
      ...sanitized
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[user-profile] POST error:', error);
    return ApiErrors.serverError('Failed to save profile data');
  }
};
