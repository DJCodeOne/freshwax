// src/pages/api/paypal/capture-order.ts
// Captures a PayPal order after customer approval and creates the order in Firebase

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createOrder, validateStock } from '../../../lib/order-utils';
import { getDocument, deleteDocument, addDocument, updateDocument, atomicIncrement, arrayUnion, queryCollection } from '../../../lib/firebase-rest';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';
import { fetchWithTimeout, errorResponse, ApiErrors } from '../../../lib/api-utils';
import { getPayPalBaseUrl, getPayPalAccessToken } from '../../../lib/paypal-auth';

// Zod schema for PayPal capture request
const PayPalCaptureSchema = z.object({
  paypalOrderId: z.string().min(1, 'PayPal order ID required'),
  orderData: z.any().optional(),
  idToken: z.string().optional(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-capture:${clientIdReq}`, RateLimiters.standard);
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

    const rawBody = await request.json();

    const parseResult = PayPalCaptureSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { paypalOrderId, orderData: clientOrderData, idToken } = parseResult.data;

    // Capture PayPal order

    // IDEMPOTENCY CHECK: Check if order with this PayPal ID already exists
    // Uses throwOnError=true so Firebase outages return 503 instead of creating duplicates
    try {
      const existingOrders = await queryCollection('orders', {
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
        limit: 1
      }, true);
      if (existingOrders && existingOrders.length > 0) {
        const existingOrder = existingOrders[0];
        // Order already exists (idempotent)
        return new Response(JSON.stringify({
          success: true,
          orderId: existingOrder.id,
          orderNumber: existingOrder.orderNumber,
          message: 'Order already processed'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (idempotencyErr) {
      console.error('[PayPal] Idempotency check failed (Firebase unreachable):', idempotencyErr);
      // Don't proceed - we can't verify if this order was already processed
      // Customer can retry when Firebase is back
      return errorResponse('Unable to verify order status. Please try again in a moment.', 503);
    }

    // SECURITY: Retrieve order data from Firebase - never trust client-submitted data
    let orderData: any;
    let usedServerData = false;
    let paypalReservationId: string | null = null;

    try {
      const pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
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
        } catch (delErr) {
          console.warn('[PayPal] Could not delete pending order:', delErr);
        }
      } else {
        // SECURITY: Reject if no server-side order exists.
        // The pending order is created during create-order and must exist for a legitimate flow.
        console.error('[PayPal] SECURITY: No pending order found for', paypalOrderId, '- rejecting capture');
        return ApiErrors.badRequest('Order session expired or invalid. Please try again.');
      }
    } catch (fetchErr) {
      console.error('[PayPal] Error fetching pending order:', fetchErr);
      return ApiErrors.serverError('Could not verify order data. Please try again.');
    }

    // P0 FIX: Validate stock BEFORE capturing payment to prevent overselling
    // Unlike Stripe webhooks, PayPal capture hasn't happened yet so we can reject
    try {
      const stockCheck = await validateStock(orderData.items || []);
      if (!stockCheck.available) {
        console.error('[PayPal] Stock unavailable before capture:', stockCheck.unavailableItems);
        return ApiErrors.conflict('Some items are no longer available');
      }
    } catch (stockErr) {
      console.error('[PayPal] Stock validation error (Firebase may be unreachable):', stockErr);
      // Fail closed: if we can't verify stock (Firebase down), don't capture payment
      // Payment hasn't been captured yet so customer isn't charged - they can retry
      return errorResponse('Unable to verify stock availability. Please try again in a moment.', 503);
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
        'PayPal-Request-Id': `capture_${paypalOrderId}_${Date.now()}`
      }
    }, 10000);

    if (!captureResponse.ok) {
      const error = await captureResponse.text();
      console.error('[PayPal] Capture error:', error);
      return ApiErrors.serverError('Failed to capture PayPal payment');
    }

    const captureResult = await captureResponse.json();
    // Capture result received

    // Verify payment was captured successfully
    if (captureResult.status !== 'COMPLETED') {
      console.error('[PayPal] Payment not completed:', captureResult.status);
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
      console.error('[PayPal] AMOUNT MISMATCH! Captured:', capturedAmount, 'Expected:', expectedTotal, 'PayPal Order:', paypalOrderId);
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
        console.warn('[PayPal] Order flagged for admin review due to amount mismatch');
      } catch (flagErr) {
        console.error('[PayPal] Failed to create flaggedOrders doc:', flagErr);
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
      } catch (d1Err) {
        // D1 write failure must not block order creation -- log and continue
        console.error('[PayPal] D1 pending_orders insert failed (non-blocking):', d1Err);
      }
    }

    // Create order in Firebase using shared utility
    // Wrap in try/catch to handle race condition: if a concurrent request already
    // created the order between our idempotency check and now, return the existing one.
    let result: any;
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
    } catch (createErr) {
      console.error('[PayPal] Order creation threw:', createErr);
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
        } catch (d1Err) {
          console.error('[PayPal] D1 pending_orders update failed (non-blocking):', d1Err);
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
          const firstOrder = duplicateCheck.sort((a: any, b: any) =>
            (a.createdAt || '').localeCompare(b.createdAt || '')
          )[0];
          console.warn('[PayPal] RACE CONDITION: Duplicate orders detected for paypalOrderId:', paypalOrderId,
            'Returning first order:', firstOrder.orderNumber);
          return new Response(JSON.stringify({
            success: true,
            orderId: firstOrder.id,
            orderNumber: firstOrder.orderNumber,
            paypalOrderId: paypalOrderId,
            message: 'Order already processed'
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (dupCheckErr) {
        console.warn('[PayPal] Post-creation duplicate check failed:', dupCheckErr);
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
        } catch (d1Err) {
          console.error('[PayPal] D1 pending_orders failure update failed:', d1Err);
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
          return new Response(JSON.stringify({
            success: true,
            orderId: existingOrder.id,
            orderNumber: existingOrder.orderNumber,
            paypalOrderId: paypalOrderId,
            message: 'Order already processed'
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (fallbackErr) {
        console.warn('[PayPal] Fallback duplicate check failed:', fallbackErr);
      }

      console.error('[PayPal] ORPHANED PAYMENT - Order creation failed after capture.',
        'PayPal Order:', paypalOrderId, 'Capture:', captureId, 'Amount:', capturedAmount,
        'Customer:', orderData.customer?.email, 'Error:', result.error);
      return ApiErrors.serverError('Payment was captured but order creation failed. Your payment is safe — our team has been notified and will process your order shortly.');
    }

    console.log('[PayPal] Order created:', result.orderNumber);

    // Convert stock reservation (payment succeeded)
    if (paypalReservationId) {
      try {
        const { convertReservation } = await import('../../../lib/order-utils');
        await convertReservation(paypalReservationId);
        // Reservation converted
      } catch (err) {
        console.error('[PayPal] Failed to convert reservation:', err);
      }
    }

    // Record to sales ledger (source of truth for analytics)
    // Look up seller info for ALL items so multi-seller orders are handled correctly
    try {
      const freshWaxFee = orderData.totals?.freshWaxFee || 0;
      // PayPal fee: approximately 2.9% + £0.30
      const paypalFee = (capturedAmount * 0.029) + 0.30;

      // Enrich items with seller info from release lookup
      const enrichedItems = await Promise.all((orderData.items || []).map(async (item: any) => {
        const releaseId = item.releaseId || item.productId || item.id;
        let submitterId = null;
        let submitterEmail = null;
        let artistName = item.artist || item.artistName || null;

        // Look up release to get submitter info
        if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
          try {
            const release = await getDocument('releases', releaseId);
            if (release) {
              submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
              // Email field - release stores it as 'email', not 'submitterEmail'
              submitterEmail = release.email || release.submitterEmail || release.metadata?.email || null;
              artistName = release.artistName || release.artist || artistName;
              // Item seller identified
            }
          } catch (lookupErr) {
            console.error(`[PayPal] Failed to lookup release ${releaseId}:`, lookupErr);
          }
        }

        // For merch items, look up the merch document for seller info
        if (item.type === 'merch' && item.productId) {
          try {
            const merch = await getDocument('merch', item.productId);
            if (merch) {
              // Check supplierId first (set by assign-seller), then sellerId, then fallbacks
              submitterId = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy || null;
              submitterEmail = merch.email || merch.sellerEmail || null;
              artistName = merch.sellerName || merch.supplierName || merch.brandName || artistName;

              // If no email on product, look up seller in users/artists collection
              if (!submitterEmail && submitterId) {
                try {
                  const userData = await getDocument('users', submitterId);
                  if (userData?.email) {
                    submitterEmail = userData.email;
                  } else {
                    const artistData = await getDocument('artists', submitterId);
                    if (artistData?.email) {
                      submitterEmail = artistData.email;
                    }
                  }
                } catch (e) {
                  // Ignore lookup errors
                }
              }

              // Merch seller identified
            }
          } catch (lookupErr) {
            console.error(`[PayPal] Failed to lookup merch ${item.productId}:`, lookupErr);
          }
        }

        return {
          ...item,
          submitterId,
          submitterEmail,
          artistName
        };
      }));

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
        hasDigital: enrichedItems.some((i: any) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
        items: enrichedItems,
        db: env?.DB  // D1 database for dual-write
      });
      // Sale recorded to ledger
    } catch (ledgerErr) {
      console.error('[PayPal] Failed to record to ledger:', ledgerErr);
      // Don't fail the order, ledger is supplementary
    }

    // Process artist payments via Stripe Connect (same as Stripe webhook)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      // Calculate total item count for fair fee splitting across all item types
      const totalItemCount = (orderData.items || []).length;

      // Calculate order subtotal for processing fee calculation
      const orderSubtotal = (orderData.items || []).reduce((sum: number, item: any) => {
        return sum + ((item.price || 0) * (item.quantity || 1));
      }, 0);

      try {
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: orderData.items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      } catch (paymentErr) {
        console.error('[PayPal] Artist payment processing error:', paymentErr);
        // Don't fail the order, just log the error
      }

      // Process merch supplier payments
      try {
        await processMerchSupplierPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: orderData.items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      } catch (supplierErr) {
        console.error('[PayPal] Supplier payment processing error:', supplierErr);
      }

      // Process vinyl crate seller payments
      try {
        await processVinylCrateSellerPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: orderData.items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      } catch (sellerErr) {
        console.error('[PayPal] Crate seller payment processing error:', sellerErr);
      }
    }

    // Deduct applied credit from user's balance atomically
    const userId = orderData.customer?.userId;
    if (appliedCredit > 0 && userId) {
      // Deducting applied credit
      try {
        const creditData = await getDocument('userCredits', userId);
        if (creditData && creditData.balance >= appliedCredit) {
          const now = new Date().toISOString();

          // Atomically decrement the balance to prevent race conditions
          await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

          // Create transaction record (append separately)
          const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const newBalance = creditData.balance - appliedCredit;
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

          // Atomic arrayUnion prevents lost transactions under concurrent writes
          await arrayUnion('userCredits', userId, 'transactions', [transaction], {
            lastUpdated: now
          });

          // Also update user document atomically
          await atomicIncrement('users', userId, { creditBalance: -appliedCredit });
          await updateDocument('users', userId, { creditUpdatedAt: now });

          // Credit deducted atomically
        } else {
          console.warn('[PayPal] Insufficient credit balance for deduction');
        }
      } catch (creditErr) {
        console.error('[PayPal] Failed to deduct credit:', creditErr);
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
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PayPal] Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal } = params;

  try {
    // Group items by artist
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
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
        // Artist not found
      }

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Artist sets full price, fees deducted from that
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const artistShare = itemTotal - freshWaxFee - processingFeePerSeller;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    // Processing artist payouts

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      // Creating pending payout

      // Always create pending payout for manual processing
      await addDocument('pendingPayouts', {
        artistId: payment.artistId,
        artistName: payment.artistName,
        artistEmail: payment.artistEmail,
        orderId,
        orderNumber,
        amount: payment.amount,
        currency: 'gbp',
        status: 'pending',
        customerPaymentMethod: 'paypal',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update artist's pending balance atomically
      try {
        await atomicIncrement('artists', payment.artistId, {
          pendingBalance: payment.amount,
        });
        await updateDocument('artists', payment.artistId, {
          updatedAt: new Date().toISOString()
        });
      } catch (e) {
        console.warn('[PayPal] Could not update artist pending balance');
      }

      // Pending payout created
    }
  } catch (error: unknown) {
    console.error('[PayPal] processArtistPayments error:', error);
    throw error;
  }
}

// Process merch supplier payments via Stripe Connect or PayPal
async function processMerchSupplierPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../../../lib/paypal-payouts');
  const paypalConfig = getPayPalConfig(env);

  try {
    // Filter to only merch items
    const merchItems = items.filter(item => item.type === 'merch');

    if (merchItems.length === 0) {
      // No merch items - skip supplier payments
      return;
    }

    // Processing merch supplier payments

    // Group items by supplier
    const supplierPayments: Record<string, {
      supplierId: string;
      supplierName: string;
      supplierEmail: string;
      stripeConnectId: string | null;
      paypalEmail: string | null;
      payoutMethod: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Cache for merch product lookups
    const merchCache: Record<string, any> = {};

    for (const item of merchItems) {
      // Get merch product data to find supplier
      const productId = item.productId || item.merchId || item.id;
      if (!productId) continue;

      let product = merchCache[productId];
      if (!product) {
        product = await getDocument('merch', productId);
        if (product) {
          merchCache[productId] = product;
        }
      }

      if (!product) {
        console.warn('[PayPal] Merch product not found:', productId);
        continue;
      }

      // Get supplier ID from product
      const supplierId = product.supplierId;
      if (!supplierId) {
        // No supplier ID on merch product - keeping revenue
        continue;
      }

      // Look up supplier for payout details
      let supplier = null;
      try {
        supplier = await getDocument('merch-suppliers', supplierId);
      } catch (e) {
        // Supplier not found
      }

      if (!supplier) continue;

      // Calculate supplier share (same structure as releases/vinyl, but 5% Fresh Wax fee)
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.05; // 5% for merch
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const supplierShare = itemTotal - freshWaxFee - processingFeePerSeller;

      // Group by supplier
      if (!supplierPayments[supplierId]) {
        supplierPayments[supplierId] = {
          supplierId,
          supplierName: supplier.name || 'Unknown Supplier',
          supplierEmail: supplier.email || '',
          stripeConnectId: supplier.stripeConnectId || null,
          paypalEmail: supplier.paypalEmail || null,
          payoutMethod: supplier.payoutMethod || null,
          amount: 0,
          items: []
        };
      }

      supplierPayments[supplierId].amount += supplierShare;
      supplierPayments[supplierId].items.push(item.name || item.title || 'Item');
    }

    // Processing supplier payments

    // Process each supplier payment
    for (const supplierId of Object.keys(supplierPayments)) {
      const payment = supplierPayments[supplierId];

      if (payment.amount <= 0) continue;

      // Processing supplier payment

      // Check preferred payout method
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        // PayPal payout for supplier - deduct 2% payout fee
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        // Paying supplier via PayPal

        try {
          const paypalResult = await createPayout(paypalConfig!, {
            email: payment.paypalEmail!,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax supplier payout for order #${orderNumber}`,
            reference: `${orderId}-supplier-${payment.supplierId}`
          });

          if (paypalResult.success) {
            await addDocument('supplierPayouts', {
              supplierId: payment.supplierId,
              supplierName: payment.supplierName,
              supplierEmail: payment.supplierEmail,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: paypalResult.batchId,
              payoutMethod: 'paypal',
              customerPaymentMethod: 'paypal',
              orderId,
              orderNumber,
              amount: paypalAmount,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              items: payment.items,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            // Atomically update supplier earnings to prevent race conditions
            await atomicIncrement('merch-suppliers', payment.supplierId, {
              totalEarnings: paypalAmount,
            });
            await updateDocument('merch-suppliers', payment.supplierId, {
              lastPayoutAt: new Date().toISOString()
            });

            // Supplier PayPal payout created
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: unknown) {
          const paypalMessage = paypalError instanceof Error ? paypalError.message : String(paypalError);
          console.error('[PayPal] Supplier PayPal payout failed:', paypalMessage);

          await addDocument('pendingSupplierPayouts', {
            supplierId: payment.supplierId,
            supplierName: payment.supplierName,
            supplierEmail: payment.supplierEmail,
            paypalEmail: payment.paypalEmail,
            payoutMethod: 'paypal',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: paypalAmount,
            paypalPayoutFee: paypalPayoutFee,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: paypalMessage,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

      } else if (useStripe) {
        // Stripe transfer for supplier
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100),
            currency: 'gbp',
            destination: payment.stripeConnectId!,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              supplierId: payment.supplierId,
              supplierName: payment.supplierName,
              type: 'merch_supplier',
              platform: 'freshwax',
              customerPaymentMethod: 'paypal'
            }
          });

          await addDocument('supplierPayouts', {
            supplierId: payment.supplierId,
            supplierName: payment.supplierName,
            supplierEmail: payment.supplierEmail,
            stripeConnectId: payment.stripeConnectId,
            stripeTransferId: transfer.id,
            payoutMethod: 'stripe',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            items: payment.items,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Atomically update supplier earnings to prevent race conditions
          await atomicIncrement('merch-suppliers', payment.supplierId, {
            totalEarnings: payment.amount,
          });
          await updateDocument('merch-suppliers', payment.supplierId, {
            lastPayoutAt: new Date().toISOString()
          });

          // Supplier Stripe transfer created

        } catch (transferError: unknown) {
          const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
          console.error('[PayPal] Supplier transfer failed:', transferMessage);

          await addDocument('pendingSupplierPayouts', {
            supplierId: payment.supplierId,
            supplierName: payment.supplierName,
            supplierEmail: payment.supplierEmail,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: transferMessage,
            customerPaymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        // Supplier not connected - store as pending
        // Supplier not connected - storing pending

        await addDocument('pendingSupplierPayouts', {
          supplierId: payment.supplierId,
          supplierName: payment.supplierName,
          supplierEmail: payment.supplierEmail,
          orderId,
          orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'awaiting_connect',
          items: payment.items,
          notificationSent: false,
          customerPaymentMethod: 'paypal',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
  } catch (error: unknown) {
    console.error('[PayPal] processMerchSupplierPayments error:', error);
    throw error;
  }
}

// Process vinyl crate seller payments via Stripe Connect or PayPal
async function processVinylCrateSellerPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../../../lib/paypal-payouts');
  const paypalConfig = getPayPalConfig(env);

  try {
    // Filter to only vinyl crate items
    const crateItems = items.filter(item =>
      item.type === 'crate' ||
      item.type === 'vinyl-crate' ||
      item.crateListingId ||
      item.sellerId
    );

    if (crateItems.length === 0) {
      // No vinyl crate items - skip seller payments
      return;
    }

    // Processing vinyl crate seller payments

    // Group items by seller
    const sellerPayments: Record<string, {
      sellerId: string;
      sellerName: string;
      sellerEmail: string;
      stripeConnectId: string | null;
      paypalEmail: string | null;
      payoutMethod: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Cache for crate listing lookups
    const listingCache: Record<string, any> = {};

    for (const item of crateItems) {
      // Get the seller info
      let sellerId = item.sellerId;
      let listingId = item.crateListingId || item.listingId;

      // If no sellerId, try to get from listing
      if (!sellerId && listingId) {
        let listing = listingCache[listingId];
        if (!listing) {
          listing = await getDocument('crateListings', listingId);
          if (listing) {
            listingCache[listingId] = listing;
          }
        }
        if (listing) {
          sellerId = listing.sellerId || listing.userId;
        }
      }

      if (!sellerId) {
        // No seller ID for crate item
        continue;
      }

      // Look up seller (user) for payout details
      let seller = null;
      try {
        seller = await getDocument('users', sellerId);
      } catch (e) {
        // Seller user not found
      }

      if (!seller) continue;

      // Calculate seller share (same structure as releases)
      // 1% Fresh Wax fee + payment processor fees
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const sellerShare = itemTotal - freshWaxFee - processingFeePerSeller;

      // Group by seller
      if (!sellerPayments[sellerId]) {
        sellerPayments[sellerId] = {
          sellerId,
          sellerName: seller.displayName || seller.name || 'Seller',
          sellerEmail: seller.email || '',
          stripeConnectId: seller.stripeConnectId || null,
          paypalEmail: seller.paypalEmail || null,
          payoutMethod: seller.payoutMethod || null,
          amount: 0,
          items: []
        };
      }

      sellerPayments[sellerId].amount += sellerShare;
      sellerPayments[sellerId].items.push(item.name || item.title || 'Vinyl');
    }

    // Processing vinyl crate seller payments

    // Process each seller payment
    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];

      if (payment.amount <= 0) continue;

      // Processing seller payment

      // Check preferred payout method
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        // PayPal payout for crate seller - deduct 2% payout fee
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        // Paying crate seller via PayPal

        try {
          const paypalResult = await createPayout(paypalConfig!, {
            email: payment.paypalEmail!,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax vinyl sale payout for order #${orderNumber}`,
            reference: `${orderId}-seller-${payment.sellerId}`
          });

          if (paypalResult.success) {
            await addDocument('crateSellerPayouts', {
              sellerId: payment.sellerId,
              sellerName: payment.sellerName,
              sellerEmail: payment.sellerEmail,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: paypalResult.batchId,
              payoutMethod: 'paypal',
              customerPaymentMethod: 'paypal',
              orderId,
              orderNumber,
              amount: paypalAmount,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              items: payment.items,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            // Atomically update crate seller earnings
            await atomicIncrement('users', payment.sellerId, {
              crateEarnings: paypalAmount,
            });
            await updateDocument('users', payment.sellerId, {
              lastCratePayoutAt: new Date().toISOString()
            });

            // Crate seller PayPal payout created
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: unknown) {
          const paypalMessage = paypalError instanceof Error ? paypalError.message : String(paypalError);
          console.error('[PayPal] Crate seller PayPal payout failed:', paypalMessage);

          await addDocument('pendingCrateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            paypalEmail: payment.paypalEmail,
            payoutMethod: 'paypal',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: paypalAmount,
            paypalPayoutFee: paypalPayoutFee,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: paypalMessage,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

      } else if (useStripe) {
        // Stripe transfer for crate seller
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100),
            currency: 'gbp',
            destination: payment.stripeConnectId!,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              sellerId: payment.sellerId,
              sellerName: payment.sellerName,
              type: 'vinyl_crate_seller',
              platform: 'freshwax',
              customerPaymentMethod: 'paypal'
            }
          });

          await addDocument('crateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            stripeConnectId: payment.stripeConnectId,
            stripeTransferId: transfer.id,
            payoutMethod: 'stripe',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            items: payment.items,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Atomically update crate seller earnings
          await atomicIncrement('users', payment.sellerId, {
            crateEarnings: payment.amount,
          });
          await updateDocument('users', payment.sellerId, {
            lastCratePayoutAt: new Date().toISOString()
          });

          // Crate seller Stripe transfer created

        } catch (transferError: unknown) {
          const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
          console.error('[PayPal] Crate seller transfer failed:', transferMessage);

          await addDocument('pendingCrateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: transferMessage,
            customerPaymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        // Seller not connected - store as pending
        // Crate seller not connected - storing pending

        await addDocument('pendingCrateSellerPayouts', {
          sellerId: payment.sellerId,
          sellerName: payment.sellerName,
          sellerEmail: payment.sellerEmail,
          orderId,
          orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'awaiting_connect',
          items: payment.items,
          notificationSent: false,
          customerPaymentMethod: 'paypal',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
  } catch (error: unknown) {
    console.error('[PayPal] processVinylCrateSellerPayments error:', error);
    throw error;
  }
}
