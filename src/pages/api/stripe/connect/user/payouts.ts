// src/pages/api/stripe/connect/user/payouts.ts
// Get crate selling payout history for a user

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'User ID required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
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

  } catch (error: any) {
    console.error('[Stripe Connect] User payouts error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get payouts'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
