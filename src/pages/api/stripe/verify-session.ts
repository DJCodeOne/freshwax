// src/pages/api/stripe/verify-session.ts
// Verifies a Stripe checkout session and returns order info
// Also creates order as fallback if webhook hasn't processed it

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser, getDocument, deleteDocument } from '../../../lib/firebase-rest';
import { createOrder, convertReservation } from '../../../lib/order-utils';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';
import { enrichItemsWithSellerInfo } from '../../../lib/stripe-webhook/seller-enrichment';
import { processArtistPayments, fetchActualStripeFee } from '../../../lib/stripe-webhook/payments';
import { processVinylCrateSellerPayments } from '../../../lib/stripe-webhook/vinyl-crate-payments';
import { createLogger, fetchWithTimeout, ApiErrors, successResponse } from '../../../lib/api-utils';
import { FIREBASE_API_KEY } from '../../../lib/constants';
import { TIMEOUTS } from '../../../lib/timeouts';

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
      TIMEOUTS.API
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
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || FIREBASE_API_KEY;

    const paymentIntentId = session.payment_intent;

    // Helper: query Firestore for order by paymentIntentId
    async function findOrderByPaymentIntent(): Promise<string | null> {
      if (!paymentIntentId) return null;
      const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;
      const resp = await fetchWithTimeout(queryUrl, {
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
      }, TIMEOUTS.API);
      if (!resp.ok) return null;
      const results = await resp.json();
      if (results && results[0]?.document) {
        return results[0].document.name.split('/').pop() || null;
      }
      return null;
    }

    // Fire line items fetch early (runs in parallel with order query below)
    // Only awaited if we reach the fallback order creation path
    const lineItemsPromise = fetchWithTimeout(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      },
      TIMEOUTS.API
    );

    // Try to find existing order by payment intent ID
    const orderId = await findOrderByPaymentIntent();
    if (orderId) {
      return successResponse({ orderId, paymentStatus: session.payment_status });
    }

    // Order not found - poll a few more times to give the webhook a chance
    // (the webhook path is preferred: it has the full pending-checkout data)
    let retryOrderId: string | null = null;
    for (let attempt = 0; attempt < 3 && !retryOrderId; attempt++) {
      await new Promise(resolve => setTimeout(resolve, TIMEOUTS.TOAST));
      retryOrderId = await findOrderByPaymentIntent();
    }
    if (retryOrderId) {
      return successResponse({ orderId: retryOrderId, paymentStatus: session.payment_status });
    }

    // Order still not found - create it now as fallback (webhook may have failed)
    log.info('Fallback order creation for paymentIntentId:', paymentIntentId);

    let items: Record<string, unknown>[] = [];
    let pendingCheckout: Record<string, unknown> | null = null;
    let artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> | null = null;

    // First try to get items from session metadata
    if (session.metadata?.items_json) {
      try {
        items = JSON.parse(session.metadata.items_json);
      } catch (e: unknown) {
        log.error('Error parsing items_json:', e);
      }
    }

    // Then the pending checkout doc (carts too large for Stripe metadata —
    // this is where vinyl orders with full item/shipping/fee data live)
    if (items.length === 0 && session.metadata?.pending_checkout_id) {
      try {
        pendingCheckout = await getDocument('pendingCheckouts', session.metadata.pending_checkout_id);
        if (pendingCheckout && Array.isArray(pendingCheckout.items)) {
          items = pendingCheckout.items as Record<string, unknown>[];
          if (pendingCheckout.artistShippingBreakdown) {
            artistShippingBreakdown = pendingCheckout.artistShippingBreakdown as typeof artistShippingBreakdown;
          }
        }
      } catch (pendingErr: unknown) {
        log.error('Error retrieving pending checkout:', pendingErr);
      }
    }

    // Last resort: line items from Stripe (no release ids — order will need
    // manual repair, but the payment is captured so we must record something)
    if (items.length === 0) {
      const lineItemsResponse = await lineItemsPromise;
      if (lineItemsResponse.ok) {
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
        log.warn('Fallback order built from raw Stripe line items — needs admin review');
      }
    }

    if (items.length === 0) {
      log.warn('No items found for fallback order');
    }

    // Build shipping info: pending checkout first, then Stripe session.
    // Stripe API 2025+ moved session shipping to collected_information.
    type ShippingShape = { address1: string; address2?: string; city: string; county?: string; postcode: string; country: string };
    let shipping: ShippingShape | null = (pendingCheckout?.shipping as ShippingShape | null) || null;
    const sessionShipping = session.shipping_details || session.collected_information?.shipping_details;
    if (!shipping && sessionShipping?.address) {
      const addr = sessionShipping.address;
      shipping = {
        address1: addr.line1 || '',
        address2: addr.line2 || '',
        city: addr.city || '',
        county: addr.state || '',
        postcode: addr.postal_code || '',
        country: addr.country || ''
      };
    }

    const pendingTotals = pendingCheckout?.totals as Record<string, number> | undefined;
    const pendingCustomer = pendingCheckout?.customer as Record<string, string> | undefined;

    // Create the order
    const result = await createOrder({
      orderData: {
        customer: {
          email: pendingCustomer?.email || session.metadata?.customer_email || session.customer_email || session.customer_details?.email || 'unknown@email.com',
          firstName: pendingCustomer?.firstName || session.metadata?.customer_firstName || session.customer_details?.name?.split(' ')[0] || 'Customer',
          lastName: pendingCustomer?.lastName || session.metadata?.customer_lastName || session.customer_details?.name?.split(' ').slice(1).join(' ') || '',
          phone: pendingCustomer?.phone || session.metadata?.customer_phone || session.customer_details?.phone || '',
          userId: pendingCustomer?.userId || session.metadata?.customer_userId || undefined
        },
        shipping,
        items,
        totals: {
          subtotal: pendingTotals?.subtotal ?? (parseFloat(session.metadata?.subtotal) || (session.amount_total / 100)),
          shipping: pendingTotals?.shipping ?? (parseFloat(session.metadata?.shipping) || 0),
          freshWaxFee: pendingTotals?.freshWaxFee ?? (parseFloat(session.metadata?.freshWaxFee) || 0),
          stripeFee: pendingTotals?.stripeFee ?? 0,
          serviceFees: pendingTotals?.serviceFees ?? (parseFloat(session.metadata?.serviceFees) || 0),
          total: pendingTotals?.total ?? (session.amount_total / 100)
        },
        hasPhysicalItems: pendingCheckout?.hasPhysicalItems === true || session.metadata?.hasPhysicalItems === 'true',
        paymentMethod: 'stripe',
        paymentIntentId: session.payment_intent
      },
      env
    });

    if (result.success) {
      log.info('Fallback order created:', result.orderNumber, result.orderId);

      // Run the post-order side effects the webhook would normally handle.
      // The webhook will see the order exists (idempotency) and skip, so
      // these only happen here. Each is non-fatal — the order exists.
      try {
        if (session.metadata?.reservation_id) {
          await convertReservation(session.metadata.reservation_id);
        }
      } catch (resErr: unknown) {
        log.error('Reservation conversion failed:', resErr);
      }

      // Artists bear the REAL Stripe fee — fetch from the balance transaction
      let actualStripeFee: number | null = null;
      if (session.payment_intent) {
        actualStripeFee = await fetchActualStripeFee(session.payment_intent, stripeSecretKey);
      }

      try {
        const serviceFees = parseFloat(session.metadata?.serviceFees) || (pendingTotals?.serviceFees ?? 0);
        const freshWaxFee = parseFloat(session.metadata?.freshWaxFee) || (pendingTotals?.freshWaxFee ?? 0);
        const stripeFee = actualStripeFee
          ?? (serviceFees > 0 ? (serviceFees - freshWaxFee) : ((session.amount_total / 100) * 0.015 + 0.20));
        const enrichedItems = await enrichItemsWithSellerInfo(items);
        await recordMultiSellerSale({
          orderId: result.orderId!,
          orderNumber: result.orderNumber || '',
          customerId: pendingCustomer?.userId || session.metadata?.customer_userId || null,
          customerEmail: pendingCustomer?.email || session.metadata?.customer_email || '',
          customerName: pendingCustomer?.firstName || session.metadata?.customer_firstName || null,
          grossTotal: session.amount_total / 100,
          shipping: pendingTotals?.shipping ?? (parseFloat(session.metadata?.shipping) || 0),
          stripeFee: Math.round(stripeFee * 100) / 100,
          freshWaxFee,
          paymentMethod: 'stripe',
          paymentId: session.payment_intent,
          hasPhysical: pendingCheckout?.hasPhysicalItems === true || session.metadata?.hasPhysicalItems === 'true',
          hasDigital: enrichedItems.some((i: Record<string, unknown>) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
          items: enrichedItems as Parameters<typeof recordMultiSellerSale>[0]['items'],
          db: env?.DB
        });
      } catch (ledgerErr: unknown) {
        log.error('Ledger recording failed:', ledgerErr);
      }

      try {
        const stripeSecretKeyForPayments = stripeSecretKey;
        const orderSubtotal = items.reduce((sum: number, item: Record<string, unknown>) =>
          sum + (((item.price as number) || 0) * ((item.quantity as number) || 1)), 0);
        await processArtistPayments({
          orderId: result.orderId!,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount: items.length,
          orderSubtotal,
          artistShippingBreakdown,
          actualStripeFee,
          stripeSecretKey: stripeSecretKeyForPayments,
          env: env as CloudflareEnv
        });
        // Crates marketplace items pay out to the listing seller, not an artist
        await processVinylCrateSellerPayments({
          orderId: result.orderId!,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount: items.length,
          orderSubtotal,
          actualStripeFee,
          stripeSecretKey: stripeSecretKeyForPayments,
          env: env as CloudflareEnv
        });
      } catch (payErr: unknown) {
        log.error('Artist payment processing failed:', payErr);
      }

      // Consume the pending checkout so it doesn't linger
      if (pendingCheckout && session.metadata?.pending_checkout_id) {
        try {
          await deleteDocument('pendingCheckouts', session.metadata.pending_checkout_id);
        } catch (cleanupErr: unknown) {
          // Non-fatal
        }
      }

      return successResponse({ orderId: result.orderId,
        orderNumber: result.orderNumber,
        paymentStatus: session.payment_status });
    }

    // Order creation failed
    log.error('Fallback order creation failed:', result.error);
    return successResponse({ orderId: null,
      paymentStatus: session.payment_status,
      message: 'Payment successful, order being processed' }, 200, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('EXCEPTION:', errorMessage);
    return ApiErrors.serverError('Session verification failed');
  }
};
