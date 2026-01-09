// src/pages/api/paypal/capture-plus-order.ts
// Captures a PayPal Plus order and activates the subscription

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { redeemReferralCode } from '../../../lib/referral-codes';

export const prerender = false;

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
    throw new Error('Failed to get PayPal access token');
  }

  const data = await response.json();
  return data.access_token;
}

// Generate Plus ID
function generatePlusId(userId: string): string {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const userHash = userId.slice(-4).toUpperCase();
  return `FWP-${year}${month}-${userHash}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-plus-capture:${clientIdReq}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    // Initialize Firebase
    const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY,
    });

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      return new Response(JSON.stringify({
        success: false,
        error: 'PayPal not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const { paypalOrderId, orderData: clientOrderData, expectedAmount } = body;

    if (!paypalOrderId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing PayPal order ID'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[PayPal Plus] Capturing order:', paypalOrderId);

    // Get pending order data from Firebase (same collection as regular orders)
    let pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
    let useClientData = false;

    if (!pendingOrder || pendingOrder.type !== 'plus_subscription') {
      // Fall back to client-provided data if Firebase lookup failed
      if (clientOrderData && clientOrderData.userId && clientOrderData.email) {
        console.log('[PayPal Plus] Using client-provided order data (Firebase lookup failed)');
        pendingOrder = {
          ...clientOrderData,
          amount: expectedAmount || 10.00, // Default to full price
          type: 'plus_subscription'
        };
        useClientData = true;
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: 'Plus order not found or expired'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    const { userId, email, amount, promoCode, isKvCode, referralCardId, referredBy } = pendingOrder;

    // Get PayPal access token and capture order
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_${paypalOrderId}_${Date.now()}`
      }
    });

    if (!captureResponse.ok) {
      const errorData = await captureResponse.json();
      console.error('[PayPal Plus] Capture failed:', errorData);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment capture failed'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const captureData = await captureResponse.json();

    if (captureData.status !== 'COMPLETED') {
      console.error('[PayPal Plus] Capture not completed:', captureData.status);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment not completed'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get capture ID
    const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id || paypalOrderId;
    console.log('[PayPal Plus] ✓ Payment captured:', captureId);

    // Validate captured amount
    const capturedAmount = parseFloat(captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0');
    if (Math.abs(capturedAmount - amount) > 0.01) {
      console.error('[PayPal Plus] Amount mismatch! Expected:', amount, 'Got:', capturedAmount);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment amount mismatch'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Delete pending order
    try {
      await deleteDocument('pendingPayPalOrders', paypalOrderId);
    } catch (e) {
      console.warn('[PayPal Plus] Failed to delete pending order:', e);
    }

    // Activate Plus subscription
    const subscribedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const plusId = generatePlusId(userId);

    const updateData = {
      fields: {
        subscription: {
          mapValue: {
            fields: {
              tier: { stringValue: 'pro' },
              subscribedAt: { stringValue: subscribedAt },
              expiresAt: { stringValue: expiresAt },
              subscriptionId: { stringValue: captureId },
              plusId: { stringValue: plusId },
              paymentMethod: { stringValue: 'paypal' },
              promoCode: { stringValue: promoCode || '' }
            }
          }
        }
      }
    };

    const updateResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      }
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('[PayPal Plus] Failed to update subscription:', errorText);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to activate subscription'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[PayPal Plus] ✓ Plus subscription activated for:', userId);

    // Send welcome email
    try {
      const origin = new URL(request.url).origin;
      await fetch(`${origin}/api/admin/send-plus-welcome-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name: email.split('@')[0],
          subscribedAt,
          expiresAt,
          plusId,
          isRenewal: false
        })
      });
      console.log('[PayPal Plus] ✓ Welcome email sent to:', email);
    } catch (emailError) {
      console.error('[PayPal Plus] Failed to send welcome email:', emailError);
    }

    // Redeem referral code if used
    if (promoCode) {
      if (isKvCode && kv) {
        // Redeem KV-based referral code
        try {
          const result = await redeemReferralCode(kv, promoCode, userId);
          if (result.success) {
            console.log(`[PayPal Plus] ✓ KV referral code ${promoCode} marked as redeemed by ${userId}`);
          } else {
            console.error(`[PayPal Plus] Failed to redeem KV code: ${result.error}`);
          }
        } catch (referralError) {
          console.error('[PayPal Plus] Failed to mark KV referral code as redeemed:', referralError);
        }
      } else if (referralCardId) {
        // Redeem Firebase-based referral code (legacy)
        try {
          const redeemData = {
            fields: {
              redeemedBy: { stringValue: userId },
              redeemedAt: { stringValue: new Date().toISOString() },
              isActive: { booleanValue: false }
            }
          };

          await fetch(
            `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/giftCards/${referralCardId}?updateMask.fieldPaths=redeemedBy&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=isActive&key=${FIREBASE_API_KEY}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(redeemData)
            }
          );
          console.log(`[PayPal Plus] ✓ Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
        } catch (referralError) {
          console.error('[PayPal Plus] Failed to mark Firebase referral code as redeemed:', referralError);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      plusId,
      expiresAt,
      message: 'Plus subscription activated successfully!'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[PayPal Plus] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to process payment',
      details: error.toString()
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
