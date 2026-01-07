// src/pages/api/payment/status.ts
// Unified payment status endpoint for all vendor types
// Uses KV caching to reduce Firebase reads

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet } from '../../../lib/kv-cache';

export const prerender = false;

const CACHE_TTL = 120; // 2 minutes cache for payment status
const CACHE_PREFIX = 'payment';

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const refresh = url.searchParams.get('refresh') === 'true';

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
  initKVCache(env);

  // Check cache first (unless refresh requested)
  const cacheKey = `status:${userId}`;
  if (!refresh) {
    const cached = await kvGet<any>(cacheKey, { prefix: CACHE_PREFIX });
    if (cached) {
      return new Response(JSON.stringify({
        ...cached,
        cached: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  try {
    // Get user data from multiple collections in parallel
    const [userDoc, artistDoc, customerDoc] = await Promise.all([
      getDocument('users', userId),
      getDocument('artists', userId),
      getDocument('customers', userId)
    ]);

    // Determine roles
    const roles = userDoc?.roles || {};
    const isArtist = roles.artist === true || artistDoc?.isArtist === true;
    const isMerchSupplier = roles.merchSupplier === true || artistDoc?.isMerchSupplier === true;
    const isVinylSeller = roles.vinylSeller === true || artistDoc?.isVinylSeller === true || customerDoc?.isVinylSeller === true;

    // Payment settings - check multiple sources
    let stripeConnectId = userDoc?.stripeConnectId || artistDoc?.stripeConnectId;
    let stripeConnectStatus = userDoc?.stripeConnectStatus || artistDoc?.stripeConnectStatus || 'not_started';
    let paypalEmail = userDoc?.paypalEmail || artistDoc?.paypalEmail;
    let payoutMethod = userDoc?.payoutMethod || artistDoc?.payoutMethod || 'stripe';

    // If Stripe account exists, verify status with Stripe
    let stripeConnected = false;
    if (stripeConnectId) {
      const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
      if (stripeSecretKey) {
        try {
          const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
          const account = await stripe.accounts.retrieve(stripeConnectId);
          stripeConnected = account.charges_enabled === true && account.payouts_enabled === true;
          stripeConnectStatus = stripeConnected ? 'active' :
            (account.requirements?.disabled_reason ? 'restricted' : 'onboarding');
        } catch (e) {
          console.error('[payment/status] Stripe error:', e);
          // Use cached status
          stripeConnected = stripeConnectStatus === 'active';
        }
      }
    }

    // Calculate earnings from payouts collections
    let earnings = {
      totalPaid: 0,
      thisMonthPaid: 0,
      totalPending: 0,
      breakdown: {} as Record<string, number>
    };

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Fetch payouts from all relevant collections
    const payoutCollections = [
      'payouts',          // Artist payouts
      'supplierPayouts',  // Merch supplier payouts
      'crateSellerPayouts' // Vinyl seller payouts
    ];

    const pendingCollections = [
      'pendingPayouts',
      'pendingSupplierPayouts',
      'pendingCrateSellerPayouts'
    ];

    // Get completed payouts
    const allPayouts: any[] = [];
    for (const collection of payoutCollections) {
      try {
        const payouts = await queryCollection(collection, {
          filters: [{ field: 'recipientId', op: 'EQUAL', value: userId }],
          orderBy: { field: 'createdAt', direction: 'DESCENDING' },
          limit: 50
        });

        for (const p of payouts) {
          const amount = p.amount || 0;
          earnings.totalPaid += amount;

          // Add type for display
          const type = collection === 'payouts' ? 'Release' :
                       collection === 'supplierPayouts' ? 'Merch' : 'Vinyl';
          allPayouts.push({ ...p, type });

          // Track by role
          if (collection === 'payouts') {
            earnings.breakdown.artist = (earnings.breakdown.artist || 0) + amount;
          } else if (collection === 'supplierPayouts') {
            earnings.breakdown.merchSupplier = (earnings.breakdown.merchSupplier || 0) + amount;
          } else {
            earnings.breakdown.vinylSeller = (earnings.breakdown.vinylSeller || 0) + amount;
          }

          // This month
          if (p.createdAt && p.createdAt >= thisMonthStart) {
            earnings.thisMonthPaid += amount;
          }
        }
      } catch (e) {
        // Collection might not exist yet
      }
    }

    // Get pending payouts
    const allPendingPayouts: any[] = [];
    for (const collection of pendingCollections) {
      try {
        const pending = await queryCollection(collection, {
          filters: [{ field: 'recipientId', op: 'EQUAL', value: userId }],
          orderBy: { field: 'createdAt', direction: 'DESCENDING' },
          limit: 20
        });

        for (const p of pending) {
          earnings.totalPending += p.amount || 0;
          const type = collection === 'pendingPayouts' ? 'Release' :
                       collection === 'pendingSupplierPayouts' ? 'Merch' : 'Vinyl';
          allPendingPayouts.push({ ...p, type });
        }
      } catch (e) {
        // Collection might not exist yet
      }
    }

    // Sort payouts by date
    allPayouts.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
    allPendingPayouts.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    // Build response data
    const responseData = {
      success: true,
      // Roles
      roles: {
        artist: isArtist,
        merchSupplier: isMerchSupplier,
        vinylSeller: isVinylSeller
      },
      // Stripe status
      stripeConnectId,
      stripeStatus: stripeConnectStatus,
      stripeConnected,
      // PayPal status
      paypalEmail: paypalEmail || null,
      paypalLinked: !!paypalEmail,
      payoutMethod,
      // Earnings
      earnings,
      // Recent payouts (limited)
      payouts: allPayouts.slice(0, 20),
      pendingPayouts: allPendingPayouts.slice(0, 10)
    };

    // Cache the result (don't await to avoid blocking response)
    kvSet(cacheKey, responseData, { prefix: CACHE_PREFIX, ttl: CACHE_TTL }).catch(() => {});

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[payment/status] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get payment status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
