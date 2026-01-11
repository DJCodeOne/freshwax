// src/pages/api/paypal/create-plus-order.ts
// Creates a PayPal order for Plus subscription purchase

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { setDocument, getDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { validateReferralCode } from '../../../lib/referral-codes';

export const prerender = false;

const PLUS_PRICE = 10.00;
const PLUS_PROMO_PRICE = 5.00;

// Get PayPal API base URL based on mode
function getPayPalBaseUrl(mode: string): string {
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// Get PayPal access token
async function getPayPalAccessToken(clientId: string, clientSecret: string, mode: string): Promise<string> {
  const baseUrl = getPayPalBaseUrl(mode);
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[PayPal Plus] Token error:', error);
    throw new Error('Failed to get PayPal access token');
  }

  const data = await response.json();
  return data.access_token;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-plus:${clientIdReq}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      console.error('[PayPal Plus] Missing credentials');
      return new Response(JSON.stringify({
        success: false,
        error: 'PayPal not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { userId, email, promoCode } = body;

    // Validate required fields
    if (!userId || !email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[PayPal Plus] Creating order for:', email);

    // Check if user already has active Plus
    const userDoc = await getDocument('users', userId);
    if (userDoc?.subscription?.tier === 'pro') {
      const expiresAt = userDoc.subscription.expiresAt;
      if (expiresAt && new Date(expiresAt) > new Date()) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You already have an active Plus subscription'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Validate referral code if provided
    let finalPrice = PLUS_PRICE;
    let validatedPromoCode: string | null = null;
    let referralCardId: string | null = null;
    let referredBy: string | null = null;
    let isKvCode = false;

    if (promoCode) {
      const normalizedCode = promoCode.toUpperCase().trim();

      // Try KV storage first (new referral code system)
      if (kv) {
        const kvResult = await validateReferralCode(kv, normalizedCode, userId, 'pro_upgrade');
        if (kvResult.valid && kvResult.referralCode) {
          validatedPromoCode = normalizedCode;
          referredBy = kvResult.referralCode.creatorId;
          isKvCode = true;
          finalPrice = PLUS_PROMO_PRICE;
          console.log(`[PayPal Plus] Valid KV referral code ${normalizedCode}, referred by ${referredBy}`);
        } else if (kvResult.error && kvResult.error !== 'Invalid referral code') {
          return new Response(JSON.stringify({
            success: false,
            error: kvResult.error
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }

      // Fall back to Firebase giftCards if not found in KV
      if (!validatedPromoCode) {
        const giftCards = await queryCollection('giftCards', {
          filters: [
            { field: 'code', op: 'EQUAL', value: normalizedCode },
            { field: 'type', op: 'EQUAL', value: 'referral' }
          ],
          limit: 1
        });

        if (giftCards && giftCards.length > 0) {
          const referralCard = giftCards[0];

          if (!referralCard.isActive || referralCard.redeemedBy) {
            return new Response(JSON.stringify({
              success: false,
              error: 'This referral code has already been used'
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }

          if (referralCard.createdByUserId === userId) {
            return new Response(JSON.stringify({
              success: false,
              error: 'You cannot use your own referral code'
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }

          validatedPromoCode = normalizedCode;
          referralCardId = referralCard.id;
          referredBy = referralCard.createdByUserId;
          finalPrice = PLUS_PROMO_PRICE;
          console.log(`[PayPal Plus] Valid Firebase referral code ${normalizedCode}, referred by ${referredBy}`);
        } else {
          return new Response(JSON.stringify({
            success: false,
            error: 'Invalid referral code'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }
    }

    // Get PayPal access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Get origin for return URLs
    const origin = new URL(request.url).origin;

    // Create PayPal order
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `plus_${userId}`,
        description: validatedPromoCode
          ? 'Fresh Wax Plus - Annual Subscription (50% off with referral)'
          : 'Fresh Wax Plus - Annual Subscription',
        amount: {
          currency_code: 'GBP',
          value: finalPrice.toFixed(2)
        }
      }],
      application_context: {
        brand_name: 'Fresh Wax',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        return_url: `${origin}/account/dashboard?paypal_plus=success`,
        cancel_url: `${origin}/account/dashboard?paypal_plus=cancelled`
      }
    };

    const paypalResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `plus_${userId}_${Date.now()}`
      },
      body: JSON.stringify(orderPayload)
    });

    if (!paypalResponse.ok) {
      const errorData = await paypalResponse.json();
      console.error('[PayPal Plus] Order creation failed:', errorData);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create PayPal order'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const paypalOrder = await paypalResponse.json();
    console.log('[PayPal Plus] Order created:', paypalOrder.id);

    // Store pending order in Firebase for security (use same collection as regular orders)
    try {
      const pendingOrderData = {
        paypalOrderId: paypalOrder.id,
        type: 'plus_subscription', // Mark as Plus order
        userId,
        email,
        amount: finalPrice,
        promoCode: validatedPromoCode,
        isKvCode,
        referralCardId,
        referredBy,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hours
      };

      await setDocument('pendingPayPalOrders', paypalOrder.id, pendingOrderData);
      console.log('[PayPal Plus] Stored pending order:', paypalOrder.id);
    } catch (storeErr) {
      console.error('[PayPal Plus] Failed to store pending order:', storeErr);
      // Continue anyway - we'll pass the data via URL params or rely on the PayPal order ID
    }

    // Find the approval URL
    const approvalUrl = paypalOrder.links?.find((link: any) => link.rel === 'approve')?.href;

    return new Response(JSON.stringify({
      success: true,
      paypalOrderId: paypalOrder.id,
      approvalUrl,
      amount: finalPrice,
      // Include order data for fallback if Firebase storage failed
      orderData: {
        userId,
        email,
        promoCode: validatedPromoCode,
        isKvCode,
        referralCardId,
        referredBy
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[PayPal Plus] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to create PayPal order',
      details: error.toString()
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
