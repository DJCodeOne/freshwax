// src/pages/api/paypal/capture-redirect.ts
// Handles PayPal redirect after customer approves payment
// Captures the payment and redirects to order confirmation

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { createOrder } from '../../../lib/order-utils';
import { getDocument, deleteDocument, atomicIncrement, arrayUnion, queryCollection } from '../../../lib/firebase-rest';
import { SITE_URL } from '../../../lib/constants';
import { createLogger } from '../../../lib/api-utils';
import { processArtistPayments, processMerchSupplierPayments, processVinylCrateSellerPayments } from '../../../lib/order/seller-payments';

const log = createLogger('[paypal-redirect]');
import { getPayPalBaseUrl, getPayPalAccessToken, paypalFetchWithRetry } from '../../../lib/paypal-auth';

// Zod schema for PayPal redirect query params
const PayPalRedirectParamsSchema = z.object({
  token: z.string().min(1, 'PayPal token required'),
  PayerID: z.string().optional(),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, redirect }) => {
  const url = new URL(request.url);
  const rawParams = {
    token: url.searchParams.get('token') || '',
    PayerID: url.searchParams.get('PayerID') || undefined,
  };

  const paramResult = PayPalRedirectParamsSchema.safeParse(rawParams);
  if (!paramResult.success) {
    log.error('[PayPal Redirect] Invalid params');
    return redirect('/checkout?error=missing_token');
  }
  const paypalOrderId = paramResult.data.token;
  const payerId = paramResult.data.PayerID;

  // PayPal redirect received

  try {
    const env = locals.runtime.env;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      log.error('[PayPal Redirect] PayPal not configured');
      return redirect('/checkout?error=config');
    }

    // IDEMPOTENCY CHECK + PENDING ORDER FETCH in parallel (independent reads)
    // Both are guard checks that may short-circuit — running them together saves a round trip
    const [idempotencySettled, pendingSettled] = await Promise.allSettled([
      queryCollection('orders', {
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
        limit: 1
      }, true),
      getDocument('pendingPayPalOrders', paypalOrderId)
    ]);

    // Check idempotency result first
    if (idempotencySettled.status === 'rejected') {
      log.error('[PayPal Redirect] Idempotency check failed (Firebase unreachable):', idempotencySettled.reason);
      // Don't proceed if we can't verify — customer can retry
      return redirect('/checkout?error=service_unavailable');
    }
    if (idempotencySettled.value && idempotencySettled.value.length > 0) {
      log.info('[PayPal Redirect] Order already exists for paypalOrderId:', paypalOrderId);
      return redirect(`${SITE_URL}/order-confirmation/${idempotencySettled.value[0].id}`);
    }

    // Check pending order result
    if (pendingSettled.status === 'rejected') {
      log.error('[PayPal Redirect] Error fetching pending order:', pendingSettled.reason);
      return redirect('/checkout?error=order_not_found');
    }
    const pendingOrder = pendingSettled.value;
    if (!pendingOrder) {
      log.error('[PayPal Redirect] No pending order found for:', paypalOrderId);
      return redirect('/checkout?error=order_not_found');
    }

    // Found pending order, capturing

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
      log.error('[PayPal Redirect] Capture error:', error);
      return redirect('/checkout?error=capture_failed');
    }

    const captureResult = await captureResponse.json();
    // Capture result received

    // Verify payment was captured successfully
    if (captureResult.status !== 'COMPLETED') {
      log.error('[PayPal Redirect] Payment not completed:', captureResult.status);
      return redirect('/checkout?error=payment_' + captureResult.status.toLowerCase());
    }

    // Get capture details
    const capture = captureResult.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id;

    // Payment captured successfully

    // Create order in Firebase
    const orderData = {
      customer: pendingOrder.customer,
      shipping: pendingOrder.shipping,
      items: pendingOrder.items,
      totals: pendingOrder.totals,
      hasPhysicalItems: pendingOrder.hasPhysicalItems,
      paymentMethod: 'paypal',
      paypalOrderId: paypalOrderId
    };

    const result = await createOrder({
      orderData,
      env
    });

    if (!result.success) {
      log.error('[PayPal Redirect] Order creation failed:', result.error);
      return redirect('/checkout?error=order_creation');
    }

    log.info('[PayPal Redirect] Order created:', result.orderNumber, result.orderId);

    // Clean up pending order
    try {
      await deleteDocument('pendingPayPalOrders', paypalOrderId);
    } catch (delErr: unknown) {
      log.warn('[PayPal Redirect] Could not delete pending order:', delErr);
    }

    // Process artist payments via Stripe Connect (same as capture-order.ts)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      // Calculate total item count for fair fee splitting across all item types
      const totalItemCount = (pendingOrder.items || []).length;

      // Calculate order subtotal for processing fee calculation
      const orderSubtotal = (pendingOrder.items || []).reduce((sum: number, item: Record<string, unknown>) => {
        return sum + ((item.price || 0) * (item.quantity || 1));
      }, 0);

      // Process all seller payment types in parallel — each is independent and
      // failures in one category should not block or delay the others
      const paymentParams = {
        orderId: result.orderId!,
        orderNumber: result.orderNumber || '',
        items: pendingOrder.items as Record<string, unknown>[],
        totalItemCount,
        orderSubtotal,
        stripeSecretKey,
        env,
        logPrefix: '[PayPal Redirect]'
      };
      const paymentResults = await Promise.allSettled([
        processArtistPayments(paymentParams),
        processMerchSupplierPayments(paymentParams),
        processVinylCrateSellerPayments(paymentParams)
      ]);
      const paymentLabels = ['Artist', 'Supplier', 'Crate seller'];
      for (let i = 0; i < paymentResults.length; i++) {
        if (paymentResults[i].status === 'rejected') {
          log.error(`[PayPal Redirect] ${paymentLabels[i]} payment processing error:`, (paymentResults[i] as PromiseRejectedResult).reason);
        }
      }
    }

    // Deduct applied credit from user's balance (atomic to prevent race conditions)
    const userId = pendingOrder.customer?.userId;
    const appliedCredit = pendingOrder.appliedCredit || pendingOrder.totals?.appliedCredit || 0;
    if (appliedCredit > 0 && userId) {
      // Deducting applied credit
      try {
        const creditData = await getDocument('userCredits', userId);
        if (creditData && creditData.balance >= appliedCredit) {
          // Use atomicIncrement for race-safe balance deduction
          await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

          const newBalance = creditData.balance - appliedCredit;
          const now = new Date().toISOString();

          const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const transaction = {
            id: transactionId,
            type: 'purchase',
            amount: -appliedCredit,
            description: `Applied to order ${result.orderNumber || result.orderId}`,
            orderId: result.orderId,
            orderNumber: result.orderNumber,
            createdAt: now,
            balanceAfter: newBalance
          };

          // Update userCredits transactions + users document in parallel (different documents)
          await Promise.all([
            // Atomic arrayUnion prevents lost transactions under concurrent writes
            arrayUnion('userCredits', userId, 'transactions', [transaction], {
              lastUpdated: now
            }),
            atomicIncrement('users', userId, { creditBalance: -appliedCredit })
          ]);

          // Credit deducted atomically
        }
      } catch (creditErr: unknown) {
        log.error('[PayPal Redirect] Failed to deduct credit:', creditErr);
      }
    }

    // Redirect to order confirmation
    return redirect(`/order-confirmation/${result.orderId}`);

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[PayPal Redirect] Error:', errorMessage);
    return redirect('/checkout?error=unknown');
  }
};

