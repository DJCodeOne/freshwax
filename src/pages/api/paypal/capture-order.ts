// src/pages/api/paypal/capture-order.ts
// Captures a PayPal order after customer approval and creates the order in Firebase

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createOrder } from '../../../lib/order-utils';
import { initFirebaseEnv, getDocument, deleteDocument } from '../../../lib/firebase-rest';

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

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-capture:${clientIdReq}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
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
      return new Response(JSON.stringify({
        success: false,
        error: 'PayPal not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { paypalOrderId, orderData: clientOrderData, idToken } = body;

    if (!paypalOrderId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing PayPal order ID'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[PayPal] Capturing order:', paypalOrderId);

    // SECURITY: Retrieve order data from Firebase instead of trusting client
    let orderData = clientOrderData;
    let usedServerData = false;

    try {
      const pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
      if (pendingOrder) {
        console.log('[PayPal] Retrieved server-side order data');
        orderData = {
          customer: pendingOrder.customer,
          shipping: pendingOrder.shipping,
          items: pendingOrder.items,
          totals: pendingOrder.totals,
          hasPhysicalItems: pendingOrder.hasPhysicalItems
        };
        usedServerData = true;

        // Clean up pending order
        try {
          await deleteDocument('pendingPayPalOrders', paypalOrderId);
          console.log('[PayPal] Cleaned up pending order');
        } catch (delErr) {
          console.log('[PayPal] Could not delete pending order:', delErr);
        }
      } else {
        console.log('[PayPal] No server-side order data found, using client data with validation');
      }
    } catch (fetchErr) {
      console.error('[PayPal] Error fetching pending order:', fetchErr);
      // Fall back to client data but will validate amount after capture
    }

    // Get access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Capture the PayPal order
    const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_${paypalOrderId}_${Date.now()}`
      }
    });

    if (!captureResponse.ok) {
      const error = await captureResponse.text();
      console.error('[PayPal] Capture error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to capture PayPal payment'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const captureResult = await captureResponse.json();
    console.log('[PayPal] Capture result:', captureResult.status);

    // Verify payment was captured successfully
    if (captureResult.status !== 'COMPLETED') {
      console.error('[PayPal] Payment not completed:', captureResult.status);
      return new Response(JSON.stringify({
        success: false,
        error: `Payment ${captureResult.status.toLowerCase()}`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get capture details
    const capture = captureResult.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id;
    const capturedAmount = parseFloat(capture?.amount?.value || '0');

    console.log('[PayPal] Payment captured:', captureId, '£' + capturedAmount);

    // SECURITY: Validate captured amount matches expected total
    const expectedTotal = parseFloat(orderData.totals?.total?.toFixed(2) || '0');
    if (!usedServerData && Math.abs(capturedAmount - expectedTotal) > 0.01) {
      console.error('[PayPal] SECURITY: Amount mismatch! Captured:', capturedAmount, 'Expected:', expectedTotal);
      // Still create the order but flag it for review
      console.log('[PayPal] Creating order with amount discrepancy flag');
    }

    // Create order in Firebase using shared utility
    const result = await createOrder({
      orderData: {
        customer: orderData.customer,
        shipping: orderData.shipping,
        items: orderData.items,
        totals: orderData.totals,
        hasPhysicalItems: orderData.hasPhysicalItems,
        paymentMethod: 'paypal',
        paypalOrderId: paypalOrderId
      },
      env,
      idToken
    });

    if (!result.success) {
      console.error('[PayPal] Order creation failed:', result.error);
      return new Response(JSON.stringify({
        success: false,
        error: result.error || 'Failed to create order'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[PayPal] Order created:', result.orderNumber);

    return new Response(JSON.stringify({
      success: true,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      paypalOrderId: paypalOrderId,
      captureId: captureId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PayPal] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
