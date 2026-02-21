// src/pages/api/paypal/capture-plus-order.ts
// Captures a PayPal Plus order and activates the subscription

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, deleteDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { redeemReferralCode } from '../../../lib/referral-codes';
import { fetchWithTimeout, ApiErrors, createLogger } from '../../../lib/api-utils';
import { getPayPalBaseUrl, getPayPalAccessToken } from '../../../lib/paypal-auth';

const logger = createLogger('paypal-plus');

// Zod schema for PayPal Plus capture
const PayPalPlusCaptureSchema = z.object({
  paypalOrderId: z.string().min(1, 'PayPal order ID required'),
  orderData: z.any().optional(),
  expectedAmount: z.number().positive().optional(),
}).passthrough();

export const prerender = false;

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
    const env = locals.runtime.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      return ApiErrors.serverError('PayPal not configured');
    }

    // SECURITY: Verify the authenticated user
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();

    const parseResult = PayPalPlusCaptureSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { paypalOrderId, orderData: clientOrderData, expectedAmount } = parseResult.data;

    logger.info('[PayPal Plus] Capturing order:', paypalOrderId);

    // Get pending order data from Firebase (same collection as regular orders)
    let pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
    if (!pendingOrder || pendingOrder.type !== 'plus_subscription') {
      // SECURITY: Reject if no server-side pending order exists.
      // Never trust client-provided order data for payment captures.
      logger.error('[PayPal Plus] No valid pending order found for:', paypalOrderId);
      return ApiErrors.badRequest('Plus order not found or expired. Please try again.');
    }

    const { userId, email, amount, promoCode, isKvCode, referralCardId, referredBy } = pendingOrder;

    // Get PayPal access token and capture order
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    const captureResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_${paypalOrderId}_${Date.now()}`
      }
    }, 10000);

    if (!captureResponse.ok) {
      const errorData = await captureResponse.json();
      logger.error('[PayPal Plus] Capture failed:', errorData);
      return ApiErrors.serverError('Payment capture failed');
    }

    const captureData = await captureResponse.json();

    if (captureData.status !== 'COMPLETED') {
      logger.error('[PayPal Plus] Capture not completed:', captureData.status);
      return ApiErrors.badRequest('Payment not completed');
    }

    // Get capture ID
    const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id || paypalOrderId;
    logger.info('[PayPal Plus] ✓ Payment captured:', captureId);

    // Validate captured amount
    const capturedAmount = parseFloat(captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0');
    if (Math.abs(capturedAmount - amount) > 0.01) {
      logger.error('[PayPal Plus] Amount mismatch! Expected:', amount, 'Got:', capturedAmount);
      return ApiErrors.badRequest('Payment amount mismatch');
    }

    // Delete pending order
    try {
      await deleteDocument('pendingPayPalOrders', paypalOrderId);
    } catch (e: unknown) {
      logger.warn('[PayPal Plus] Failed to delete pending order:', e);
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

    const updateResponse = await fetchWithTimeout(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      },
      10000
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      logger.error('[PayPal Plus] Failed to update subscription:', errorText);
      return ApiErrors.serverError('Failed to activate subscription');
    }

    logger.info('[PayPal Plus] ✓ Plus subscription activated for:', userId);

    // Send welcome email
    try {
      const origin = new URL(request.url).origin;
      await fetchWithTimeout(`${origin}/api/admin/send-plus-welcome-email/`, {
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
      }, 10000);
      logger.info('[PayPal Plus] ✓ Welcome email sent to:', email);
    } catch (emailError: unknown) {
      logger.error('[PayPal Plus] Failed to send welcome email:', emailError);
    }

    // Redeem referral code if used
    if (promoCode) {
      if (isKvCode && kv) {
        // Redeem KV-based referral code
        try {
          const result = await redeemReferralCode(kv, promoCode, userId);
          if (result.success) {
            logger.info(`[PayPal Plus] ✓ KV referral code ${promoCode} marked as redeemed by ${userId}`);
          } else {
            logger.error(`[PayPal Plus] Failed to redeem KV code: ${result.error}`);
          }
        } catch (referralError: unknown) {
          logger.error('[PayPal Plus] Failed to mark KV referral code as redeemed:', referralError);
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

          await fetchWithTimeout(
            `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/giftCards/${referralCardId}?updateMask.fieldPaths=redeemedBy&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=isActive&key=${FIREBASE_API_KEY}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(redeemData)
            },
            10000
          );
          logger.info(`[PayPal Plus] ✓ Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
        } catch (referralError: unknown) {
          logger.error('[PayPal Plus] Failed to mark Firebase referral code as redeemed:', referralError);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      plusId,
      expiresAt,
      message: 'Plus subscription activated successfully!'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    logger.error('[PayPal Plus] Error:', error);
    return ApiErrors.serverError('Failed to process payment');
  }
};
