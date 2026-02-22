// src/pages/api/stripe/verify-session.ts
// Verifies a Stripe checkout session and returns order info
// Also creates order as fallback if webhook hasn't processed it

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { createOrder } from '../../../lib/order-utils';
import { createLogger, fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[verify-session]');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

// Zod schema for verify-session query params
const VerifySessionParamsSchema = z.object({
  session_id: z.string().min(1, 'session_id required'),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`verify-session:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // SECURITY: Verify user authentication via Firebase token
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    const rawParams = { session_id: url.searchParams.get('session_id') || '' };
    const paramResult = VerifySessionParamsSchema.safeParse(rawParams);
    if (!paramResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const sessionId = paramResult.data.session_id;

    const env = locals.runtime.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return ApiErrors.serverError('Stripe not configured');
    }

    // Retrieve the session from Stripe
    const sessionResponse = await fetchWithTimeout(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      },
      10000
    );

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      log.error('Invalid session response:', sessionResponse.status, errorText);
      return ApiErrors.badRequest('Invalid session');
    }

    const session = await sessionResponse.json();

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      return ApiErrors.badRequest('Payment not completed');
    }

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

    // Try to find order by payment intent ID
    const paymentIntentId = session.payment_intent;

    if (paymentIntentId) {
      // Query Firestore for order with this payment intent
      const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

      const queryResponse = await fetchWithTimeout(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'orders' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'paymentIntentId' },
                op: 'EQUAL',
                value: { stringValue: paymentIntentId }
              }
            },
            limit: 1
          }
        })
      }, 10000);

      if (queryResponse.ok) {
        const results = await queryResponse.json();

        if (results && results[0]?.document) {
          const docPath = results[0].document.name;
          const orderId = docPath.split('/').pop();

          return new Response(JSON.stringify({
            success: true,
            orderId,
            paymentStatus: session.payment_status
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // Order not found - wait a bit more and check again (webhook might be processing)
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 more seconds

    // Check again after waiting
    if (paymentIntentId) {
      const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;
      const retryResponse = await fetchWithTimeout(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'orders' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'paymentIntentId' },
                op: 'EQUAL',
                value: { stringValue: paymentIntentId }
              }
            },
            limit: 1
          }
        })
      }, 10000);

      if (retryResponse.ok) {
        const retryResults = await retryResponse.json();
        if (retryResults && retryResults[0]?.document) {
          const docPath = retryResults[0].document.name;
          const orderId = docPath.split('/').pop();
          return new Response(JSON.stringify({
            success: true,
            orderId,
            paymentStatus: session.payment_status
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // Order still not found - create it now as fallback (webhook may have failed)
    log.info('Fallback order creation for paymentIntentId:', paymentIntentId);

    // Get line items from Stripe session
    const lineItemsResponse = await fetchWithTimeout(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      },
      10000
    );

    let items: Record<string, unknown>[] = [];

    // First try to get items from session metadata
    if (session.metadata?.items_json) {
      try {
        items = JSON.parse(session.metadata.items_json);
      } catch (e: unknown) {
        log.error('Error parsing items_json:', e);
      }
    }

    // Fallback to line items from Stripe
    if (items.length === 0 && lineItemsResponse.ok) {
      const lineItemsData = await lineItemsResponse.json();
      items = (lineItemsData.data || [])
        .filter((item: Record<string, unknown>) => item.description !== 'Processing and platform fees' && item.description !== 'Service Fee')
        .map((item: Record<string, unknown>, index: number) => ({
          id: `stripe_item_${index}`,
          name: item.description || 'Item',
          price: (item.amount_total || item.price?.unit_amount || 0) / 100,
          quantity: item.quantity || 1,
          type: 'digital'
        }));
    }

    if (items.length === 0) {
      log.warn('No items found for fallback order');
    }

    // Build shipping info if present
    let shipping = null;
    if (session.shipping_details?.address) {
      const addr = session.shipping_details.address;
      shipping = {
        address1: addr.line1 || '',
        address2: addr.line2 || '',
        city: addr.city || '',
        county: addr.state || '',
        postcode: addr.postal_code || '',
        country: addr.country || ''
      };
    }

    // Create the order
    const result = await createOrder({
      orderData: {
        customer: {
          email: session.metadata?.customer_email || session.customer_email || session.customer_details?.email || 'unknown@email.com',
          firstName: session.metadata?.customer_firstName || session.customer_details?.name?.split(' ')[0] || 'Customer',
          lastName: session.metadata?.customer_lastName || session.customer_details?.name?.split(' ').slice(1).join(' ') || '',
          phone: session.metadata?.customer_phone || session.customer_details?.phone || '',
          userId: session.metadata?.customer_userId || undefined
        },
        shipping,
        items,
        totals: {
          subtotal: parseFloat(session.metadata?.subtotal) || (session.amount_total / 100),
          shipping: parseFloat(session.metadata?.shipping) || 0,
          serviceFees: parseFloat(session.metadata?.serviceFees) || 0,
          total: session.amount_total / 100
        },
        hasPhysicalItems: session.metadata?.hasPhysicalItems === 'true',
        paymentMethod: 'stripe',
        paymentIntentId: session.payment_intent
      },
      env
    });

    if (result.success) {
      log.info('Fallback order created:', result.orderNumber, result.orderId);
      return new Response(JSON.stringify({
        success: true,
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        paymentStatus: session.payment_status
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Order creation failed
    log.error('Fallback order creation failed:', result.error);
    return new Response(JSON.stringify({
      success: true,
      orderId: null,
      paymentStatus: session.payment_status,
      message: 'Payment successful, order being processed'
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('EXCEPTION:', errorMessage);
    return ApiErrors.serverError('Session verification failed');
  }
};
