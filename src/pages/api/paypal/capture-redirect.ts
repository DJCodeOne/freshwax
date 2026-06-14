// src/pages/api/paypal/capture-redirect.ts
// Handles PayPal redirect after customer approves payment
// Captures the payment and redirects to order confirmation

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { createOrder } from '../../../lib/order-utils';
import { getDocument, deleteDocument, addDocument, atomicIncrement, arrayUnion, queryCollection, invalidateReleasesCache, clearAllMerchCache } from '../../../lib/firebase-rest';
import { invalidateReleasesKVCache } from '../../../lib/kv-cache';
import { SITE_URL } from '../../../lib/constants';
import { createLogger } from '../../../lib/api-utils';
import { processArtistPayments, processMerchSupplierPayments, processVinylCrateSellerPayments } from '../../../lib/order/seller-payments';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';
import { enrichItemsForLedger, processMerchRoyalties } from '../../../lib/order/paypal-capture-helpers';
import { getProcessingFee } from '../../../lib/order/seller-payments/types';

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
    // ACTUAL PayPal fee from the capture response — sellers bear the real
    // fee, not the 2.9%+30p estimate
    const actualPayPalFee = parseFloat(capture?.seller_receivable_breakdown?.paypal_fee?.value || '') || null;

    // Amount verification: compare captured amount against the SERVER-stored
    // expected total. Don't block (customer already paid) — flag for admin
    // review. Mirrors capture-order.ts so the mobile/redirect path isn't weaker.
    const capturedAmount = parseFloat(capture?.amount?.value || '0');
    const expectedTotal = parseFloat(Number(pendingOrder.totals?.total ?? 0).toFixed(2));
    if (Math.abs(capturedAmount - expectedTotal) > 0.01) {
      log.error('[PayPal Redirect] AMOUNT MISMATCH! Captured:', capturedAmount, 'Expected:', expectedTotal, 'PayPal Order:', paypalOrderId);
      try {
        await addDocument('flaggedOrders', {
          paypalOrderId,
          captureId,
          capturedAmount,
          expectedTotal,
          difference: Math.round((capturedAmount - expectedTotal) * 100) / 100,
          customerEmail: pendingOrder.customer?.email || '',
          reason: 'amount_mismatch',
          status: 'needs_review',
          source: 'capture-redirect',
          createdAt: new Date().toISOString()
        });
      } catch (flagErr: unknown) {
        log.error('[PayPal Redirect] Failed to create flaggedOrders doc:', flagErr);
      }
    }

    // Payment captured successfully

    // Backfill customer.userId if missing (PayPal redirect loses the auth context)
    if (!pendingOrder.customer?.userId) {
      try {
        const { verifyRequestUser } = await import('../../../lib/firebase-rest');
        const { userId } = await verifyRequestUser(request);
        if (userId && pendingOrder.customer) {
          pendingOrder.customer.userId = userId;
        }
      } catch (_e: unknown) { /* auth verification failed — continue without userId */ }
    }

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

    // Calculate order subtotal for processing fee calculation (also used by ledger below)
    const orderSubtotal = (pendingOrder.items || []).reduce((sum: number, item: Record<string, unknown>) => {
      return sum + ((item.price || 0) * (item.quantity || 1));
    }, 0);

    // Record to sales ledger (source of truth for admin dashboard analytics).
    // Mirror of capture-order.ts — capture-redirect.ts (mobile/redirect PayPal flow)
    // previously didn't write here, leaving recent PayPal sales out of dashboard totals.
    try {
      const grossTotal = pendingOrder.totals?.total ?? orderSubtotal;
      const paypalFee = actualPayPalFee ?? getProcessingFee(grossTotal, 'paypal');
      const freshWaxFee = pendingOrder.totals?.freshWaxFee || 0;
      const itemsList = (pendingOrder.items as Record<string, unknown>[]) || [];
      const enrichedItems = await enrichItemsForLedger(itemsList);
      await recordMultiSellerSale({
        orderId: result.orderId!,
        orderNumber: result.orderNumber || '',
        customerId: pendingOrder.customer?.userId || null,
        customerEmail: pendingOrder.customer?.email || '',
        customerName: pendingOrder.customer?.displayName || pendingOrder.customer?.firstName || null,
        grossTotal,
        shipping: pendingOrder.totals?.shipping || 0,
        paypalFee: Math.round(paypalFee * 100) / 100,
        freshWaxFee,
        paymentMethod: 'paypal',
        paymentId: paypalOrderId,
        hasPhysical: pendingOrder.hasPhysicalItems,
        hasDigital: enrichedItems.some((i: Record<string, unknown>) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
        items: enrichedItems,
        db: env?.DB
      });
    } catch (ledgerErr: unknown) {
      log.error('[PayPal Redirect] Failed to record to ledger:', ledgerErr);
      // Non-fatal: dashboard analytics will be slightly off but order itself is fine
    }

    // Process artist payments via Stripe Connect (same as capture-order.ts)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      // Calculate total item count for fair fee splitting across all item types
      const totalItemCount = (pendingOrder.items || []).length;

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
        logPrefix: '[PayPal Redirect]',
        paymentMethod: 'paypal' as const,
        actualProcessingFee: actualPayPalFee,
        // Artists receive 100% of their vinyl shipping (stored at create time)
        artistShippingBreakdown: (pendingOrder.artistShippingBreakdown as Record<string, { artistId: string; artistName: string; amount: number }> | null) || null
      };
      const paymentResults = await Promise.allSettled([
        processArtistPayments(paymentParams),
        processMerchRoyalties(paymentParams), // 10% brand royalty (brandAccountId)
        processMerchSupplierPayments(paymentParams), // supplier share (merch.supplierId)
        processVinylCrateSellerPayments(paymentParams)
      ]);
      const paymentLabels = ['Artist', 'Brand royalty', 'Merch supplier', 'Crate seller'];
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

    // Invalidate caches so stock changes appear immediately (mirrors Stripe webhook)
    try {
      const soldItems = (pendingOrder.items as Record<string, unknown>[]) || [];
      const hasReleaseItems = soldItems.some((i) => i.type === 'digital' || i.type === 'release' || i.type === 'track' || i.type === 'vinyl');
      const hasMerchItems = soldItems.some((i) => i.type === 'merch');
      if (hasReleaseItems) {
        invalidateReleasesCache();
        await invalidateReleasesKVCache();
      }
      if (hasMerchItems) {
        clearAllMerchCache();
      }
    } catch (cacheErr: unknown) {
      log.warn('[PayPal Redirect] Cache invalidation failed (non-blocking):', cacheErr);
    }

    // Redirect to order confirmation
    return redirect(`/order-confirmation/${result.orderId}`);

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[PayPal Redirect] Error:', errorMessage);
    return redirect('/checkout?error=unknown');
  }
};

