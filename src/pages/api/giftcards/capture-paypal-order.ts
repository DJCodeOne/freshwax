// src/pages/api/giftcards/capture-paypal-order.ts
// Captures a PayPal order for gift card purchase and creates the gift card

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, deleteDocument, queryCollection, addDocument, updateDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { createGiftCardAfterPayment } from '../../../lib/giftcard';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('giftcards/capture-paypal-order');
import { getPayPalBaseUrl, getPayPalAccessToken } from '../../../lib/paypal-auth';

// Zod schema for gift card PayPal capture
const GiftCardCaptureSchema = z.object({
  paypalOrderId: z.string().min(1, 'PayPal order ID required'),
}).strip();

export const prerender = false;

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

    // Check for idempotency - has this order already been processed?
    const existingCards = await queryCollection('giftCards', {
      filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
      limit: 1
    });

    if (existingCards.length > 0) {
      return successResponse({ alreadyProcessed: true,
        giftCard: {
          code: existingCards[0].code,
          amount: existingCards[0].originalValue,
          recipientEmail: existingCards[0].recipientEmail
        } });
    }

    // Retrieve order data from Firebase
    let pendingOrder = null;
    try {
      pendingOrder = await getDocument('pendingGiftCardOrders', paypalOrderId);
    } catch (fetchErr: unknown) {
      log.error('Error fetching pending order:', fetchErr);
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
      log.error('Capture error:', error);
      return ApiErrors.serverError('Failed to capture PayPal payment');
    }

    const captureResult = await captureResponse.json();
    if (captureResult.status !== 'COMPLETED') {
      return ApiErrors.badRequest('Payment not completed');
    }

    // Validate captured amount matches expected
    const capturedAmount = parseFloat(
      captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0'
    );

    if (Math.abs(capturedAmount - pendingOrder.amount) > 0.01) {
      log.error('Amount mismatch! Expected:', pendingOrder.amount, 'Got:', capturedAmount);
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
      log.error('Failed to create gift card:', result.error);
      return ApiErrors.serverError(result.error || 'Failed to create gift card');
    }

    // Clean up pending order
    try {
      await deleteDocument('pendingGiftCardOrders', paypalOrderId);
    } catch (delErr: unknown) {
      log.warn('Could not delete pending order:', delErr);
    }

    return successResponse({ giftCard: result.giftCard,
      emailSent: result.emailSent });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};
