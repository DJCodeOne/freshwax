// src/pages/api/paypal/capture-order.ts
// Captures a PayPal order after customer approval and creates the order in Firebase
// AUTH: PayPal API serves as authentication — captures a payment that must exist in
// PayPal's system. Also validates against a server-side pending order document.
// Guest checkout is supported so no user auth is required.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createOrder, validateStock } from '../../../lib/order-utils';
import { getDocument, deleteDocument, addDocument, queryCollection } from '../../../lib/firebase-rest';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';
import { createLogger, errorResponse, successResponse, ApiErrors } from '../../../lib/api-utils';
import { processArtistPayments, processVinylCrateSellerPayments } from '../../../lib/order/seller-payments';
import { processMerchRoyalties, enrichItemsForLedger, deductAppliedCredit } from '../../../lib/order/paypal-capture-helpers';

const log = createLogger('[paypal-capture]');
import { getPayPalBaseUrl, getPayPalAccessToken, paypalFetchWithRetry } from '../../../lib/paypal-auth';

// Zod schema for PayPal capture request
const PayPalCaptureSchema = z.object({
  paypalOrderId: z.string().min(1, 'PayPal order ID required'),
  orderData: z.record(z.unknown()).optional(),
  idToken: z.string().optional(),
}).strip();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-capture:${clientIdReq}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      return ApiErrors.serverError('PayPal not configured');
    }

    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON');
    }

    const parseResult = PayPalCaptureSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { paypalOrderId, orderData: clientOrderData, idToken } = parseResult.data;

    // Capture PayPal order

    // IDEMPOTENCY CHECK + PENDING ORDER FETCH in parallel (independent reads)
    // Both are guard checks that may short-circuit — running them together saves a round trip
    let idempotencyResult: { existingOrders: Record<string, unknown>[] | null; error: unknown } = { existingOrders: null, error: null };
    let pendingOrderResult: { pendingOrder: Record<string, unknown> | null; error: unknown } = { pendingOrder: null, error: null };

    const [idempotencySettled, pendingSettled] = await Promise.allSettled([
      queryCollection('orders', {
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
        limit: 1
      }, true),
      getDocument('pendingPayPalOrders', paypalOrderId)
    ]);

    if (idempotencySettled.status === 'fulfilled') {
      idempotencyResult.existingOrders = idempotencySettled.value;
    } else {
      idempotencyResult.error = idempotencySettled.reason;
    }

    if (pendingSettled.status === 'fulfilled') {
      pendingOrderResult.pendingOrder = pendingSettled.value;
    } else {
      pendingOrderResult.error = pendingSettled.reason;
    }

    // Check idempotency result first
    if (idempotencyResult.error) {
      log.error('[PayPal] Idempotency check failed (Firebase unreachable):', idempotencyResult.error);
      // Don't proceed - we can't verify if this order was already processed
      // Customer can retry when Firebase is back
      return errorResponse('Unable to verify order status. Please try again in a moment.', 503);
    }
    if (idempotencyResult.existingOrders && idempotencyResult.existingOrders.length > 0) {
      const existingOrder = idempotencyResult.existingOrders[0];
      // Order already exists (idempotent)
      return successResponse({ orderId: existingOrder.id,
        orderNumber: existingOrder.orderNumber,
        message: 'Order already processed' });
    }

    // Check pending order result
    if (pendingOrderResult.error) {
      log.error('[PayPal] Error fetching pending order:', pendingOrderResult.error);
      return ApiErrors.serverError('Could not verify order data. Please try again.');
    }

    // SECURITY: Retrieve order data from Firebase - never trust client-submitted data
    let orderData: Record<string, unknown>;
    let usedServerData = false;
    let paypalReservationId: string | null = null;

    const pendingOrder = pendingOrderResult.pendingOrder;
    if (pendingOrder) {
      // Retrieved server-side order data
      paypalReservationId = pendingOrder.reservationId || null;
      orderData = {
        customer: pendingOrder.customer,
        shipping: pendingOrder.shipping,
        items: pendingOrder.items,
        totals: pendingOrder.totals,
        hasPhysicalItems: pendingOrder.hasPhysicalItems,
        appliedCredit: pendingOrder.appliedCredit || 0
      };
      usedServerData = true;

      // Clean up pending order
      try {
        await deleteDocument('pendingPayPalOrders', paypalOrderId);
        // Cleaned up pending order
      } catch (delErr: unknown) {
        log.warn('[PayPal] Could not delete pending order:', delErr);
      }
    } else {
      // SECURITY: Reject if no server-side order exists.
      // The pending order is created during create-order and must exist for a legitimate flow.
      log.error('[PayPal] SECURITY: No pending order found for', paypalOrderId, '- rejecting capture');
      return ApiErrors.badRequest('Order session expired or invalid. Please try again.');
    }

    // P0 FIX: Validate stock BEFORE capturing payment to prevent overselling
    // Unlike Stripe webhooks, PayPal capture hasn't happened yet so we can reject
    try {
      const stockCheck = await validateStock(orderData.items || []);
      if (!stockCheck.available) {
        log.error('[PayPal] Stock unavailable before capture:', stockCheck.unavailableItems);
        return ApiErrors.conflict('Some items are no longer available');
      }
    } catch (stockErr: unknown) {
      log.error('[PayPal] Stock validation error (Firebase may be unreachable):', stockErr);
      // Fail closed: if we can't verify stock (Firebase down), don't capture payment
      // Payment hasn't been captured yet so customer isn't charged - they can retry
      return errorResponse('Unable to verify stock availability. Please try again in a moment.', 503);
    }

    // Get access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Capture the PayPal order
    const captureResponse = await paypalFetchWithRetry(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_${paypalOrderId}_${Date.now()}`
      }
    }, 10000);

    if (!captureResponse.ok) {
      const error = await captureResponse.text();
      log.error('[PayPal] Capture error:', error);
      return ApiErrors.serverError('Failed to capture PayPal payment');
    }

    const captureResult = await captureResponse.json();
    // Capture result received

    // Verify payment was captured successfully
    if (captureResult.status !== 'COMPLETED') {
      log.error('[PayPal] Payment not completed:', captureResult.status);
      return ApiErrors.badRequest('Payment was not completed. Please try again.');
    }

    // Get capture details
    const capture = captureResult.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id;
    const capturedAmount = parseFloat(capture?.amount?.value || '0');

    // Payment captured successfully

    // Amount verification: compare captured amount against expected total
    // Don't block on mismatch -- the customer already paid. Flag for admin review instead.
    const expectedTotal = parseFloat(orderData.totals?.total?.toFixed(2) || '0');
    let amountMismatch = false;
    if (Math.abs(capturedAmount - expectedTotal) > 0.01) {
      amountMismatch = true;
      log.error('[PayPal] AMOUNT MISMATCH! Captured:', capturedAmount, 'Expected:', expectedTotal, 'PayPal Order:', paypalOrderId);
      // Flag for admin review via Firebase document
      try {
        await addDocument('flaggedOrders', {
          paypalOrderId,
          captureId,
          capturedAmount,
          expectedTotal,
          difference: Math.round((capturedAmount - expectedTotal) * 100) / 100,
          customerEmail: orderData.customer?.email || '',
          reason: 'amount_mismatch',
          status: 'needs_review',
          createdAt: new Date().toISOString()
        });
        log.warn('[PayPal] Order flagged for admin review due to amount mismatch');
      } catch (flagErr: unknown) {
        log.error('[PayPal] Failed to create flaggedOrders doc:', flagErr);
      }
    }

    // Get applied credit from order data
    const appliedCredit = orderData.appliedCredit || 0;

    // D1 DURABLE RECORD: Insert pending order before Firebase creation
    // If Firebase fails after payment, this record ensures the order is not lost
    // Reuses the same pending_orders table as the Stripe webhook for admin visibility
    const db = env?.DB;
    if (db) {
      try {
        await db.prepare(`
          INSERT INTO pending_orders (stripe_session_id, customer_email, amount_total, currency, items, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
        `).bind(
          `paypal:${paypalOrderId}`,
          orderData.customer?.email || '',
          Math.round(capturedAmount * 100),
          'gbp',
          JSON.stringify(orderData.items || [])
        ).run();
        // D1 pending_orders row inserted
      } catch (d1Err: unknown) {
        // D1 write failure must not block order creation -- log and continue
        log.error('[PayPal] D1 pending_orders insert failed (non-blocking):', d1Err);
      }
    }

    // Create order in Firebase using shared utility
    // Wrap in try/catch to handle race condition: if a concurrent request already
    // created the order between our idempotency check and now, return the existing one.
    let result: { success: boolean; orderId?: string; orderNumber?: string; error?: string };
    try {
      result = await createOrder({
        orderData: {
          customer: orderData.customer,
          shipping: orderData.shipping,
          items: orderData.items,
          totals: {
            ...orderData.totals,
            appliedCredit,
            amountPaid: capturedAmount,
            ...(amountMismatch ? { amountMismatch: true, expectedTotal, capturedAmount } : {})
          },
          hasPhysicalItems: orderData.hasPhysicalItems,
          paymentMethod: 'paypal',
          paypalOrderId: paypalOrderId,
          ...(amountMismatch ? { flagged: true, flagReason: 'amount_mismatch' } : {})
        },
        env,
        idToken
      });
    } catch (createErr: unknown) {
      log.error('[PayPal] Order creation threw:', createErr);
      result = { success: false, error: createErr instanceof Error ? createErr.message : 'Order creation failed' };
    }

    // After creation attempt, re-check for existing order to handle race condition.
    // If two requests passed the initial idempotency check simultaneously, one will
    // have created the order by now. Return the existing order instead of duplicating.
    if (result.success) {
      // D1: Mark pending order as completed with Firebase order ID
      if (db) {
        try {
          await db.prepare(`
            UPDATE pending_orders
            SET status = 'completed', firebase_order_id = ?, updated_at = datetime('now')
            WHERE stripe_session_id = ?
          `).bind(result.orderId || '', `paypal:${paypalOrderId}`).run();
          // D1 pending_orders updated to completed
        } catch (d1Err: unknown) {
          log.error('[PayPal] D1 pending_orders update failed (non-blocking):', d1Err);
        }
      }

      try {
        const duplicateCheck = await queryCollection('orders', {
          filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
          limit: 2
        });
        if (duplicateCheck && duplicateCheck.length > 1) {
          // Race condition detected: multiple orders for same paypalOrderId
          // Return the first one (earliest created) and log the duplicate
          const firstOrder = duplicateCheck.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
            ((a.createdAt as string) || '').localeCompare((b.createdAt as string) || '')
          )[0];
          log.warn('[PayPal] RACE CONDITION: Duplicate orders detected for paypalOrderId:', paypalOrderId,
            'Returning first order:', firstOrder.orderNumber);
          return successResponse({ orderId: firstOrder.id,
            orderNumber: firstOrder.orderNumber,
            paypalOrderId: paypalOrderId,
            message: 'Order already processed' });
        }
      } catch (dupCheckErr: unknown) {
        log.warn('[PayPal] Post-creation duplicate check failed:', dupCheckErr);
        // Non-fatal: continue with the order we created
      }
    }

    if (!result.success) {
      // D1: Mark pending order as failed so admin can see the failure reason
      if (db) {
        try {
          await db.prepare(`
            UPDATE pending_orders
            SET status = 'failed', updated_at = datetime('now')
            WHERE stripe_session_id = ?
          `).bind(`paypal:${paypalOrderId}`).run();
          // D1 pending_orders marked as failed
        } catch (d1Err: unknown) {
          log.error('[PayPal] D1 pending_orders failure update failed:', d1Err);
        }
      }

      // Before returning an error, check one more time if a concurrent request created the order
      try {
        const existingOrders = await queryCollection('orders', {
          filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
          limit: 1
        });
        if (existingOrders && existingOrders.length > 0) {
          const existingOrder = existingOrders[0];
          // Order creation failed but existing order found (race condition)
          return successResponse({ orderId: existingOrder.id,
            orderNumber: existingOrder.orderNumber,
            paypalOrderId: paypalOrderId,
            message: 'Order already processed' });
        }
      } catch (fallbackErr: unknown) {
        log.warn('[PayPal] Fallback duplicate check failed:', fallbackErr);
      }

      log.error('[PayPal] ORPHANED PAYMENT - Order creation failed after capture.',
        'PayPal Order:', paypalOrderId, 'Capture:', captureId, 'Amount:', capturedAmount,
        'Customer:', orderData.customer?.email, 'Error:', result.error);
      return ApiErrors.serverError('Payment was captured but order creation failed. Your payment is safe — our team has been notified and will process your order shortly.');
    }

    log.info('[PayPal] Order created:', result.orderNumber);

    // Activate Plus membership if order contains Plus items
    const plusItems = ((orderData.items as Record<string, unknown>[]) || []).filter(
      (item: Record<string, unknown>) => item.type === 'plus'
    );
    if (plusItems.length > 0 && orderData.customer?.userId) {
      try {
        const { activateSubscription } = await import('../../../lib/stripe-webhook/subscription-helpers');
        await activateSubscription({
          userId: orderData.customer.userId as string,
          email: (orderData.customer.email || '') as string,
          userName: (orderData.customer.displayName || orderData.customer.firstName || '') as string,
          subscriptionId: `paypal:${paypalOrderId}`,
          promoCode: (plusItems[0] as Record<string, unknown>).promoCode as string || null,
          referralCardId: null,
          isKvCode: false,
          env,
          requestUrl: request.url,
          startTime: Date.now(),
          eventType: 'paypal.capture.completed',
          eventId: captureId || paypalOrderId
        });
        log.info('[PayPal] Plus membership activated via cart checkout for:', orderData.customer.userId);
      } catch (plusErr: unknown) {
        log.error('[PayPal] Failed to activate Plus from cart:', plusErr);
      }
    }

    // Convert stock reservation (payment succeeded)
    if (paypalReservationId) {
      try {
        const { convertReservation } = await import('../../../lib/order-utils');
        await convertReservation(paypalReservationId);
        // Reservation converted
      } catch (err: unknown) {
        log.error('[PayPal] Failed to convert reservation:', err);
      }
    }

    // Record to sales ledger (source of truth for analytics)
    // Look up seller info for ALL items so multi-seller orders are handled correctly
    try {
      const freshWaxFee = orderData.totals?.freshWaxFee || 0;
      // PayPal fee: approximately 2.9% + £0.30
      const paypalFee = (capturedAmount * 0.029) + 0.30;

      const itemsList = (orderData.items as Record<string, unknown>[]) || [];
      const enrichedItems = await enrichItemsForLedger(itemsList);

      // Use multi-seller recording to create per-seller ledger entries
      // Dual-write: D1 (primary) + Firebase (backup)
      await recordMultiSellerSale({
        orderId: result.orderId,
        orderNumber: result.orderNumber || '',
        customerId: orderData.customer?.userId || null,
        customerEmail: orderData.customer?.email || '',
        customerName: orderData.customer?.displayName || orderData.customer?.firstName || null,
        grossTotal: capturedAmount,
        shipping: orderData.totals?.shipping || 0,
        paypalFee: Math.round(paypalFee * 100) / 100,
        freshWaxFee,
        paymentMethod: 'paypal',
        paymentId: paypalOrderId,
        hasPhysical: orderData.hasPhysicalItems,
        hasDigital: enrichedItems.some((i: Record<string, unknown>) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
        items: enrichedItems,
        db: env?.DB  // D1 database for dual-write
      });
      // Sale recorded to ledger
    } catch (ledgerErr: unknown) {
      log.error('[PayPal] Failed to record to ledger:', ledgerErr);
      // Don't fail the order, ledger is supplementary
    }

    // Process artist payments via Stripe Connect (same as Stripe webhook)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      // Calculate total item count for fair fee splitting across all item types
      const totalItemCount = (orderData.items || []).length;

      // Calculate order subtotal for processing fee calculation
      const orderSubtotal = ((orderData.items as Record<string, unknown>[]) || []).reduce((sum: number, item: Record<string, unknown>) => {
        return sum + ((item.price || 0) * (item.quantity || 1));
      }, 0);

      // Process all seller payment types in parallel — each is independent and
      // failures in one category should not block or delay the others
      const paymentParams = {
        orderId: result.orderId!,
        orderNumber: result.orderNumber || '',
        items: orderData.items as Record<string, unknown>[],
        totalItemCount,
        orderSubtotal,
        stripeSecretKey,
        env,
        logPrefix: '[PayPal]'
      };
      const paymentResults = await Promise.allSettled([
        processArtistPayments(paymentParams),
        processMerchRoyalties(paymentParams),
        processVinylCrateSellerPayments(paymentParams)
      ]);
      const paymentLabels = ['Artist', 'Supplier', 'Crate seller'];
      for (let i = 0; i < paymentResults.length; i++) {
        if (paymentResults[i].status === 'rejected') {
          log.error(`[PayPal] ${paymentLabels[i]} payment processing error:`, (paymentResults[i] as PromiseRejectedResult).reason);
        }
      }
    }

    // Deduct applied credit from user's balance atomically
    const userId = orderData.customer?.userId;
    if (appliedCredit > 0 && userId) {
      await deductAppliedCredit({
        userId: userId as string,
        appliedCredit: appliedCredit as number,
        orderId: result.orderId!,
        orderNumber: result.orderNumber
      });
    }

    return successResponse({ orderId: result.orderId,
      orderNumber: result.orderNumber,
      paypalOrderId: paypalOrderId,
      captureId: captureId }, 200, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[PayPal] Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};
