// src/pages/api/giftcards/create-paypal-order.ts
// Creates a PayPal order for gift card purchases

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { setDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout } from '../../../lib/api-utils';

// Zod schema for gift card PayPal order creation
const GiftCardPayPalSchema = z.object({
  amount: z.union([z.number(), z.string()]).refine(val => {
    const num = typeof val === 'string' ? parseInt(val) : val;
    return num >= 5 && num <= 500;
  }, 'Amount must be between 5 and 500'),
  buyerUserId: z.string().min(1, 'Buyer user ID required'),
  buyerEmail: z.string().email('Valid buyer email required'),
  buyerName: z.string().max(200).optional(),
  recipientType: z.enum(['self', 'gift']).optional(),
  recipientName: z.string().max(200).optional(),
  recipientEmail: z.string().email().optional(),
  message: z.string().max(500).optional(),
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
    const env = locals.runtime.env;

    // SECURITY: Verify the requesting user's identity
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

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

    const rawBody = await request.json();

    const parseResult = GiftCardPayPalSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Invalid request',
        details: parseResult.error.issues
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const data = parseResult.data;
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

    // SECURITY: Ensure the authenticated user matches the buyer
    if (buyerUserId !== verifiedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only purchase gift cards for your own account'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const numAmount = parseInt(String(amount));

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
        return_url: `${SITE_URL}/giftcards/success`,
        cancel_url: `${SITE_URL}/giftcards`
      }
    };

    // Create PayPal order
    const createResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `freshwax_gc_${Date.now()}_${Math.random().toString(36).substring(7)}`
      },
      body: JSON.stringify(paypalOrder)
    }, 10000);

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
      error: 'An internal error occurred'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
