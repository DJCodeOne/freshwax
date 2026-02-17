// src/pages/api/user/export-data.ts
// GDPR Article 20 — Data portability endpoint
// Returns all user data as downloadable JSON

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection, verifyUserToken } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

const ExportDataSchema = z.object({
  userId: z.string().min(1, 'userId is required').max(200),
  idToken: z.string().min(1, 'idToken is required').max(5000),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`export-data:${clientId}`, RateLimiters.destructive);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json();
    const parsed = ExportDataSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId, idToken } = parsed.data;

    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only export your own data');
    }

    const exportData: Record<string, any> = {
      exportDate: new Date().toISOString(),
      userId,
    };

    // 1. User profile
    try {
      const profile = await getDocument('users', userId);
      if (profile) {
        // Strip internal fields
        const { __collections__, ...userData } = profile;
        exportData.profile = userData;
      }
    } catch (_) {}

    // 2. Artist profile
    try {
      const artist = await getDocument('artists', userId);
      if (artist) exportData.artistProfile = artist;
    } catch (_) {}

    // 3. Orders
    try {
      const orders = await queryCollection('orders', {
        filters: [{ field: 'customer.userId', op: 'EQUAL', value: userId }],
        limit: 500,
        skipCache: true
      });
      if (orders.length) exportData.orders = orders;
    } catch (_) {}

    // 4. Comments
    try {
      const comments = await queryCollection('comments', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
        limit: 500,
        skipCache: true
      });
      if (comments.length) exportData.comments = comments;
    } catch (_) {}

    // 5. DJ Mixes
    try {
      const mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
        limit: 200,
        skipCache: true
      });
      if (mixes.length) exportData.djMixes = mixes;
    } catch (_) {}

    // 6. Vinyl listings
    try {
      const listings = await queryCollection('vinylListings', {
        filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }],
        limit: 500,
        skipCache: true
      });
      if (listings.length) exportData.vinylListings = listings;
    } catch (_) {}

    // 7. Vinyl seller profile
    try {
      const seller = await getDocument('vinylSellers', userId);
      if (seller) exportData.vinylSellerProfile = seller;
    } catch (_) {}

    // 8. Livestream bookings
    try {
      const bookings = await queryCollection('livestream-bookings', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
        limit: 200,
        skipCache: true
      });
      if (bookings.length) exportData.livestreamBookings = bookings;
    } catch (_) {}

    // 9. Newsletter subscription
    try {
      const email = exportData.profile?.email;
      if (email) {
        const subscriberId = email.toLowerCase().trim().replace(/[.@]/g, '_');
        const sub = await getDocument('subscribers', subscriberId);
        if (sub) exportData.newsletterSubscription = sub;
      }
    } catch (_) {}

    return new Response(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="freshwax-data-export-${userId.slice(0, 8)}.json"`,
      }
    });

  } catch (error: unknown) {
    console.error('[export-data] Error:', error);
    return ApiErrors.serverError('Failed to export data');
  }
};

// GET forwards to POST for manual triggering from dashboard
export const GET: APIRoute = async (context) => {
  return ApiErrors.methodNotAllowed('Use POST with userId and idToken');
};
