// src/pages/api/giftcards/capture-paypal-order.ts
// Captures a PayPal order for gift card purchase and creates the gift card

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, deleteDocument, queryCollection, addDocument, updateDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { createGiftCardAfterPayment } from '../../../lib/giftcard';
import { fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';

// Zod schema for gift card PayPal capture
const GiftCardCaptureSchema = z.object({
  paypalOrderId: z.string().min(1, 'PayPal order ID required'),
}).passthrough();

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

  const response = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 10000);

  if (!response.ok) {
    throw new Error('Failed to get PayPal access token');
  }

  const data = await response.json();
  return data.access_token;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-paypal-capture:${clientIdReq}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      return ApiErrors.serverError('PayPal not configured');
    }

    const rawBody = await request.json();

    const parseResult = GiftCardCaptureSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { paypalOrderId } = parseResult.data;

    console.log('[GiftCard PayPal] Capturing order:', paypalOrderId);

    // Check for idempotency - has this order already been processed?
    const existingCards = await queryCollection('giftCards', {
      filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
      limit: 1
    });

    if (existingCards.length > 0) {
      console.log('[GiftCard PayPal] Order already processed:', paypalOrderId);
      return new Response(JSON.stringify({
        success: true,
        alreadyProcessed: true,
        giftCard: {
          code: existingCards[0].code,
          amount: existingCards[0].originalValue,
          recipientEmail: existingCards[0].recipientEmail
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Retrieve order data from Firebase
    let pendingOrder = null;
    try {
      pendingOrder = await getDocument('pendingGiftCardOrders', paypalOrderId);
      if (pendingOrder) {
        console.log('[GiftCard PayPal] Retrieved pending order data');
      }
    } catch (fetchErr) {
      console.error('[GiftCard PayPal] Error fetching pending order:', fetchErr);
    }

    if (!pendingOrder) {
      return ApiErrors.badRequest('Order not found or expired');
    }

    // SECURITY: Verify the caller is the buyer who created this order
    const { userId: verifiedUserId } = await verifyRequestUser(request);
    if (verifiedUserId && verifiedUserId !== pendingOrder.buyerUserId) {
      return ApiErrors.forbidden('You can only capture your own orders');
    }

    // Get access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Capture the PayPal order
    const captureResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_gc_${paypalOrderId}_${Date.now()}`
      }
    }, 10000);

    if (!captureResponse.ok) {
      const error = await captureResponse.text();
      console.error('[GiftCard PayPal] Capture error:', error);
      return ApiErrors.serverError('Failed to capture PayPal payment');
    }

    const captureResult = await captureResponse.json();
    console.log('[GiftCard PayPal] Capture result:', captureResult.status);

    if (captureResult.status !== 'COMPLETED') {
      return ApiErrors.badRequest('Payment not completed');
    }

    // Validate captured amount matches expected
    const capturedAmount = parseFloat(
      captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0'
    );

    if (Math.abs(capturedAmount - pendingOrder.amount) > 0.01) {
      console.error('[GiftCard PayPal] Amount mismatch! Expected:', pendingOrder.amount, 'Got:', capturedAmount);
      return ApiErrors.badRequest('Payment amount mismatch');
    }

    // Create the gift card
    const result = await createGiftCardAfterPayment({
      amount: pendingOrder.amount,
      buyerUserId: pendingOrder.buyerUserId,
      buyerEmail: pendingOrder.buyerEmail,
      buyerName: pendingOrder.buyerName,
      recipientType: pendingOrder.recipientType,
      recipientName: pendingOrder.recipientName,
      recipientEmail: pendingOrder.recipientEmail,
      message: pendingOrder.message,
      paypalOrderId: paypalOrderId
    }, {
      queryCollection,
      addDocument,
      updateDocument,
      getDocument
    });

    if (!result.success) {
      console.error('[GiftCard PayPal] Failed to create gift card:', result.error);
      return ApiErrors.serverError(result.error || 'Failed to create gift card');
    }

    // Clean up pending order
    try {
      await deleteDocument('pendingGiftCardOrders', paypalOrderId);
      console.log('[GiftCard PayPal] Cleaned up pending order');
    } catch (delErr) {
      console.log('[GiftCard PayPal] Could not delete pending order:', delErr);
    }

    console.log('[GiftCard PayPal] Gift card created successfully:', result.giftCard?.code);

    return new Response(JSON.stringify({
      success: true,
      giftCard: result.giftCard,
      emailSent: result.emailSent
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[GiftCard PayPal] Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};
