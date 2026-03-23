// src/pages/api/stripe/connect/payouts.ts
// Returns payout history for an artist

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, verifyRequestUser } from '@lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '@lib/api-utils';

const log = createLogger('stripe/connect/payouts');

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-connect-payouts:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase
  const env = locals.runtime.env;


  try {
    // SECURITY: Verify user authentication via Firebase token
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);

    if (!verifiedUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const artistId = verifiedUserId;

    // Get artist document for summary stats
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return ApiErrors.notFound('Artist not found');
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
    const pendingBalance = pendingPayouts.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0);

    // Calculate this month's earnings
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthPayouts = payouts.filter((p: Record<string, unknown>) =>
      new Date(p.createdAt as string) >= monthStart && p.status === 'completed'
    );
    const thisMonthEarnings = thisMonthPayouts.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0);

    // Check for more results
    const hasMore = payouts.length > limit;
    const resultPayouts = hasMore ? payouts.slice(0, limit) : payouts;

    return successResponse({ payouts: resultPayouts,
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
      } });

  } catch (error: unknown) {
    log.error('[Stripe Connect] Payouts error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to fetch payouts');
  }
};
