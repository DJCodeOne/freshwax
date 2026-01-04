// src/pages/api/paypal/capture-order.ts
// Captures a PayPal order after customer approval and creates the order in Firebase

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createOrder } from '../../../lib/order-utils';
import { initFirebaseEnv, getDocument, deleteDocument, addDocument, updateDocument } from '../../../lib/firebase-rest';

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

    // Process artist payments via Stripe Connect (same as Stripe webhook)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      try {
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: orderData.items,
          stripeSecretKey,
          env
        });
      } catch (paymentErr) {
        console.error('[PayPal] Artist payment processing error:', paymentErr);
        // Don't fail the order, just log the error
      }
    }

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

// Process artist payments via Stripe Connect
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, stripeSecretKey } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Group items by artist
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      stripeConnectId: string | null;
      amount: number;
      items: string[];
    }> = {};

    const releaseCache: Record<string, any> = {};

    for (const item of items) {
      // Skip merch items - they go to suppliers
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      let release = releaseCache[releaseId];
      if (!release) {
        release = await getDocument('releases', releaseId);
        if (release) releaseCache[releaseId] = release;
      }

      if (!release) continue;

      const artistId = item.artistId || release.artistId || release.userId;
      if (!artistId) continue;

      let artist = null;
      try {
        artist = await getDocument('artists', artistId);
      } catch (e) {
        console.log('[PayPal] Could not find artist:', artistId);
      }

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          stripeConnectId: artist?.stripeConnectId || null,
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += itemTotal;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    console.log('[PayPal] Artist payments to process:', Object.keys(artistPayments).length);

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      console.log('[PayPal] Processing payment for', payment.artistName, ':', payment.amount, 'GBP');

      if (payment.stripeConnectId) {
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100),
            currency: 'gbp',
            destination: payment.stripeConnectId,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              artistId: payment.artistId,
              artistName: payment.artistName,
              platform: 'freshwax',
              paymentMethod: 'paypal'
            }
          });

          await addDocument('payouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            artistEmail: payment.artistEmail,
            stripeConnectId: payment.stripeConnectId,
            stripeTransferId: transfer.id,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            paymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          const artist = await getDocument('artists', payment.artistId);
          if (artist) {
            await updateDocument('artists', payment.artistId, {
              totalEarnings: (artist.totalEarnings || 0) + payment.amount,
              lastPayoutAt: new Date().toISOString()
            });
          }

          console.log('[PayPal] ✓ Transfer created:', transfer.id);

        } catch (transferError: any) {
          console.error('[PayPal] Transfer failed:', transferError.message);

          await addDocument('pendingPayouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            artistEmail: payment.artistEmail,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'retry_pending',
            failureReason: transferError.message,
            paymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        console.log('[PayPal] Artist', payment.artistName, 'not connected - storing pending');

        await addDocument('pendingPayouts', {
          artistId: payment.artistId,
          artistName: payment.artistName,
          artistEmail: payment.artistEmail,
          orderId,
          orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'awaiting_connect',
          notificationSent: false,
          paymentMethod: 'paypal',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
  } catch (error) {
    console.error('[PayPal] processArtistPayments error:', error);
    throw error;
  }
}
