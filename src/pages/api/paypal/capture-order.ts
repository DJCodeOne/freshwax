// src/pages/api/paypal/capture-order.ts
// Captures a PayPal order after customer approval and creates the order in Firebase

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createOrder, validateStock } from '../../../lib/order-utils';
import { getDocument, deleteDocument, addDocument, updateDocument, atomicIncrement, arrayUnion, queryCollection } from '../../../lib/firebase-rest';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';

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

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

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

    // IDEMPOTENCY CHECK: Check if order with this PayPal ID already exists
    // Uses throwOnError=true so Firebase outages return 503 instead of creating duplicates
    try {
      const existingOrders = await queryCollection('orders', {
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
        limit: 1
      }, true);
      if (existingOrders && existingOrders.length > 0) {
        const existingOrder = existingOrders[0];
        console.log('[PayPal] Order already exists for this payment:', existingOrder.orderNumber);
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
      return new Response(JSON.stringify({
        success: false,
        error: 'Unable to verify order status. Please try again in a moment.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SECURITY: Retrieve order data from Firebase - never trust client-submitted data
    let orderData: any;
    let usedServerData = false;
    let paypalReservationId: string | null = null;

    try {
      const pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
      if (pendingOrder) {
        console.log('[PayPal] Retrieved server-side order data');
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
          console.log('[PayPal] Cleaned up pending order');
        } catch (delErr) {
          console.log('[PayPal] Could not delete pending order:', delErr);
        }
      } else {
        // SECURITY: Reject if no server-side order exists.
        // The pending order is created during create-order and must exist for a legitimate flow.
        console.error('[PayPal] SECURITY: No pending order found for', paypalOrderId, '- rejecting capture');
        return new Response(JSON.stringify({
          success: false,
          error: 'Order session expired or invalid. Please try again.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (fetchErr) {
      console.error('[PayPal] Error fetching pending order:', fetchErr);
      return new Response(JSON.stringify({
        success: false,
        error: 'Could not verify order data. Please try again.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // P0 FIX: Validate stock BEFORE capturing payment to prevent overselling
    // Unlike Stripe webhooks, PayPal capture hasn't happened yet so we can reject
    try {
      const stockCheck = await validateStock(orderData.items || []);
      if (!stockCheck.available) {
        console.error('[PayPal] Stock unavailable before capture:', stockCheck.unavailableItems);
        return new Response(JSON.stringify({
          success: false,
          error: 'Some items are no longer available',
          unavailableItems: stockCheck.unavailableItems
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (stockErr) {
      console.error('[PayPal] Stock validation error (Firebase may be unreachable):', stockErr);
      // Fail closed: if we can't verify stock (Firebase down), don't capture payment
      // Payment hasn't been captured yet so customer isn't charged - they can retry
      return new Response(JSON.stringify({
        success: false,
        error: 'Unable to verify stock availability. Please try again in a moment.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
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
        console.log('[PayPal] D1 pending_orders row inserted for paypal order:', paypalOrderId);
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
          console.log('[PayPal] D1 pending_orders updated to completed for paypal order:', paypalOrderId);
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
        console.log('[PayPal] Post-creation duplicate check failed:', dupCheckErr);
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
          console.log('[PayPal] D1 pending_orders marked as failed for paypal order:', paypalOrderId);
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
          console.log('[PayPal] Order creation failed but existing order found (race condition):', existingOrder.orderNumber);
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
        console.log('[PayPal] Fallback duplicate check failed:', fallbackErr);
      }

      console.error('[PayPal] ORPHANED PAYMENT - Order creation failed after capture.',
        'PayPal Order:', paypalOrderId, 'Capture:', captureId, 'Amount:', capturedAmount,
        'Customer:', orderData.customer?.email, 'Error:', result.error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment was captured but order creation failed. Your payment is safe — our team has been notified and will process your order shortly.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[PayPal] Order created:', result.orderNumber);

    // Convert stock reservation (payment succeeded)
    if (paypalReservationId) {
      try {
        const { convertReservation } = await import('../../../lib/order-utils');
        await convertReservation(paypalReservationId);
        console.log('[PayPal] Reservation converted:', paypalReservationId);
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
              console.log(`[PayPal] Item ${item.name}: seller=${submitterId}`);
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

              console.log(`[PayPal] Merch ${item.name}: seller=${submitterId}`);
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
      console.log('[PayPal] Sale recorded to ledger (D1 + Firebase)');
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
      console.log('[PayPal] Deducting applied credit:', appliedCredit, 'from user:', userId);
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

          console.log('[PayPal] Credit deducted atomically, approx new balance:', newBalance);
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
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PayPal] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
        console.log('[PayPal] Could not find artist:', artistId);
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

    console.log('[PayPal] Artist pending payouts to create:', Object.keys(artistPayments).length);

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      console.log('[PayPal] Creating pending payout for', payment.artistName, ':', payment.amount.toFixed(2), 'GBP');

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
        console.log('[PayPal] Could not update artist pending balance');
      }

      console.log('[PayPal] ✓ Pending payout created for', payment.artistName);
    }
  } catch (error) {
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
      console.log('[PayPal] No merch items in order - skipping supplier payments');
      return;
    }

    console.log('[PayPal] Processing', merchItems.length, 'merch items for supplier payments');

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
        console.log('[PayPal] Merch product not found:', productId);
        continue;
      }

      // Get supplier ID from product
      const supplierId = product.supplierId;
      if (!supplierId) {
        console.log('[PayPal] No supplier ID on merch product:', productId, '- keeping revenue');
        continue;
      }

      // Look up supplier for payout details
      let supplier = null;
      try {
        supplier = await getDocument('merch-suppliers', supplierId);
      } catch (e) {
        console.log('[PayPal] Could not find supplier:', supplierId);
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

    console.log('[PayPal] Supplier payments to process:', Object.keys(supplierPayments).length);

    // Process each supplier payment
    for (const supplierId of Object.keys(supplierPayments)) {
      const payment = supplierPayments[supplierId];

      if (payment.amount <= 0) continue;

      console.log('[PayPal] Processing payment for supplier', payment.supplierName, ':', payment.amount.toFixed(2), 'GBP');

      // Check preferred payout method
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        // PayPal payout for supplier - deduct 2% payout fee
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        console.log('[PayPal] Paying supplier', payment.supplierName, '£' + paypalAmount.toFixed(2), 'via PayPal (2% fee: £' + paypalPayoutFee.toFixed(2) + ')');

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

            console.log('[PayPal] ✓ Supplier PayPal payout created:', paypalResult.batchId);
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

          console.log('[PayPal] ✓ Supplier Stripe transfer created:', transfer.id);

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
        console.log('[PayPal] Supplier', payment.supplierName, 'not connected - storing pending');

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
  } catch (error) {
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
      console.log('[PayPal] No vinyl crate items in order - skipping seller payments');
      return;
    }

    console.log('[PayPal] Processing', crateItems.length, 'vinyl crate items for seller payments');

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
        console.log('[PayPal] No seller ID for crate item:', item.name);
        continue;
      }

      // Look up seller (user) for payout details
      let seller = null;
      try {
        seller = await getDocument('users', sellerId);
      } catch (e) {
        console.log('[PayPal] Could not find seller user:', sellerId);
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

    console.log('[PayPal] Vinyl crate seller payments to process:', Object.keys(sellerPayments).length);

    // Process each seller payment
    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];

      if (payment.amount <= 0) continue;

      console.log('[PayPal] Processing payment for seller', payment.sellerName, ':', payment.amount.toFixed(2), 'GBP');

      // Check preferred payout method
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        // PayPal payout for crate seller - deduct 2% payout fee
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        console.log('[PayPal] Paying crate seller', payment.sellerName, '£' + paypalAmount.toFixed(2), 'via PayPal (2% fee: £' + paypalPayoutFee.toFixed(2) + ')');

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

            console.log('[PayPal] ✓ Crate seller PayPal payout created:', paypalResult.batchId);
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

          console.log('[PayPal] ✓ Crate seller Stripe transfer created:', transfer.id);

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
        console.log('[PayPal] Crate seller', payment.sellerName, 'not connected - storing pending');

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
  } catch (error) {
    console.error('[PayPal] processVinylCrateSellerPayments error:', error);
    throw error;
  }
}
