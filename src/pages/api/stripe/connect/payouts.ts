// src/pages/api/stripe/connect/payouts.ts
// Returns payout history for an artist

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv, verifyRequestUser } from '../../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-connect-payouts:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // SECURITY: Verify user authentication via Firebase token
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);

    // Fall back to cookies if no Authorization header (for browser requests)
    const partnerId = cookies.get('partnerId')?.value;
    const firebaseUid = cookies.get('firebaseUid')?.value;
    const artistId = verifiedUserId || partnerId || firebaseUid;

    if (!artistId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Get artist document for summary stats
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    // Fetch completed payouts
    const payouts = await queryCollection('payouts', {
      filters: [{ field: 'artistId', op: 'EQUAL', value: artistId }],
      orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
      limit: limit + 1  // Fetch one extra to check if there are more
    });

    // Fetch pending payouts
    const pendingPayouts = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'artistId', op: 'EQUAL', value: artistId },
        { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
      ],
      orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }]
    });

    // Calculate totals
    const totalEarnings = artist.totalEarnings || 0;
    const pendingBalance = pendingPayouts.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

    // Calculate this month's earnings
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthPayouts = payouts.filter((p: any) =>
      new Date(p.createdAt) >= monthStart && p.status === 'completed'
    );
    const thisMonthEarnings = thisMonthPayouts.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

    // Check for more results
    const hasMore = payouts.length > limit;
    const resultPayouts = hasMore ? payouts.slice(0, limit) : payouts;

    return new Response(JSON.stringify({
      success: true,
      payouts: resultPayouts,
      pendingPayouts: pendingPayouts,
      summary: {
        totalEarnings,
        pendingBalance,
        thisMonthEarnings,
        lastPayoutAt: artist.lastPayoutAt || null,
        stripeConnected: !!artist.stripeConnectId && artist.stripeConnectStatus === 'active'
      },
      pagination: {
        limit,
        offset,
        hasMore
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] Payouts error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to fetch payouts'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
