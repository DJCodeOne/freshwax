// src/pages/api/giftcards/create-paypal-order.ts
// Creates a PayPal order for gift card purchases

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

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
    const error = await response.text();
    console.error('[GiftCard PayPal] Token error:', error);
    throw new Error('Failed to get PayPal access token');
  }

  const data = await response.json();
  return data.access_token;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-paypal:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;

    // Initialize Firebase for storing pending orders
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      console.error('[GiftCard PayPal] Missing credentials');
      return new Response(JSON.stringify({
        success: false,
        error: 'PayPal not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await request.json();
    const {
      amount,
      buyerUserId,
      buyerEmail,
      buyerName,
      recipientType,
      recipientName,
      recipientEmail,
      message
    } = data;

    // Validate amount
    const numAmount = parseInt(amount);
    if (!numAmount || numAmount < 5 || numAmount > 500) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid amount. Must be between £5 and £500.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate buyer
    if (!buyerUserId || !buyerEmail) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Must be logged in to purchase'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate recipient email for gift type
    const targetEmail = recipientType === 'gift' ? recipientEmail : buyerEmail;
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid recipient email address'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[GiftCard PayPal] Creating order for:', buyerEmail, 'amount:', numAmount);

    // Get access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Build PayPal order request
    const paypalOrder = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'freshwax_giftcard',
        description: `Fresh Wax Gift Card - £${numAmount}`,
        amount: {
          currency_code: 'GBP',
          value: numAmount.toFixed(2),
          breakdown: {
            item_total: {
              currency_code: 'GBP',
              value: numAmount.toFixed(2)
            }
          }
        },
        items: [{
          name: `Fresh Wax Gift Card - £${numAmount}`,
          unit_amount: {
            currency_code: 'GBP',
            value: numAmount.toFixed(2)
          },
          quantity: '1',
          category: 'DIGITAL_GOODS'
        }]
      }],
      application_context: {
        brand_name: 'Fresh Wax',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        return_url: 'https://freshwax.co.uk/giftcards/success',
        cancel_url: 'https://freshwax.co.uk/giftcards'
      }
    };

    // Create PayPal order
    const createResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `freshwax_gc_${Date.now()}_${Math.random().toString(36).substring(7)}`
      },
      body: JSON.stringify(paypalOrder)
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      console.error('[GiftCard PayPal] Create order error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create PayPal order'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const paypalResult = await createResponse.json();
    console.log('[GiftCard PayPal] Order created:', paypalResult.id);

    // Extract approval URL
    const approvalLink = paypalResult.links?.find((link: any) => link.rel === 'approve');
    const approvalUrl = approvalLink?.href || null;

    // Store pending gift card order data for secure retrieval during capture
    try {
      const pendingOrder = {
        paypalOrderId: paypalResult.id,
        type: 'giftcard',
        amount: numAmount,
        buyerUserId,
        buyerEmail,
        buyerName: buyerName || '',
        recipientType: recipientType || 'self',
        recipientName: recipientName || '',
        recipientEmail: targetEmail,
        message: message || '',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hour expiry
      };

      await setDocument('pendingGiftCardOrders', paypalResult.id, pendingOrder);
      console.log('[GiftCard PayPal] Stored pending order:', paypalResult.id);
    } catch (storeErr) {
      console.error('[GiftCard PayPal] Failed to store pending order:', storeErr);
      // Continue - capture will need to validate amount
    }

    return new Response(JSON.stringify({
      success: true,
      orderId: paypalResult.id,
      status: paypalResult.status,
      approvalUrl: approvalUrl
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[GiftCard PayPal] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
