// src/pages/api/stripe/connect/user/payouts.ts
// Get crate selling payout history for a user

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, verifyRequestUser } from '../../../../../lib/firebase-rest';
import { ApiErrors, createLogger } from '../../../../../lib/api-utils';

const log = createLogger('stripe/connect/user/payouts');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-user-payouts:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  if (!userId) {
    return ApiErrors.badRequest('User ID required');
  }

  const env = locals.runtime.env;


  // SECURITY: Verify user authentication via Firebase token
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  // SECURITY: Verify the authenticated user matches the requested userId
  if (authUserId !== userId) {
    return ApiErrors.forbidden('Forbidden');
  }

  try {
    const user = await getDocument('users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    // Get crate seller payouts
    const payouts = await queryCollection('crateSellerPayouts', {
      filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }],
      orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
      limit
    });

    // Calculate totals
    let totalPaid = 0;
    let totalPending = 0;
    let thisMonthPaid = 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    for (const payout of payouts) {
      if (payout.status === 'completed') {
        totalPaid += payout.amount || 0;
        if (payout.completedAt >= monthStart) {
          thisMonthPaid += payout.amount || 0;
        }
      } else if (payout.status === 'pending') {
        totalPending += payout.amount || 0;
      }
    }

    // Get pending payouts (for sellers not yet connected)
    const pendingPayouts = await queryCollection('pendingCrateSellerPayouts', {
      filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }],
      limit: 50
    });

    for (const pending of pendingPayouts) {
      totalPending += pending.amount || 0;
    }

    return new Response(JSON.stringify({
      success: true,
      payouts: payouts.map((p: any) => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        amount: p.amount,
        status: p.status,
        items: p.items,
        createdAt: p.createdAt,
        completedAt: p.completedAt
      })),
      pendingPayouts: pendingPayouts.map((p: any) => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        amount: p.amount,
        items: p.items,
        createdAt: p.createdAt
      })),
      summary: {
        totalPaid,
        totalPending,
        thisMonthPaid,
        payoutCount: payouts.length,
        crateEarnings: user.crateEarnings || 0,
        pendingCrateBalance: user.pendingCrateBalance || 0
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    log.error('[Stripe Connect] User payouts error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get payouts');
  }
};
