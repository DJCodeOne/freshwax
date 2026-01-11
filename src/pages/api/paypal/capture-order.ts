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
      // BLOCK the order - this is a security concern
      // PayPal already captured the money, so we need to handle refund separately
      // But we should NOT create an order with manipulated data
      return new Response(JSON.stringify({
        success: false,
        error: 'Order validation failed. Payment captured but order could not be created. Please contact support.',
        refundRequired: true,
        captureId: captureId
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get applied credit from order data
    const appliedCredit = orderData.appliedCredit || 0;

    // Create order in Firebase using shared utility
    const result = await createOrder({
      orderData: {
        customer: orderData.customer,
        shipping: orderData.shipping,
        items: orderData.items,
        totals: {
          ...orderData.totals,
          appliedCredit,
          amountPaid: capturedAmount
        },
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

      // Process merch supplier payments
      try {
        await processMerchSupplierPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: orderData.items,
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
          stripeSecretKey,
          env
        });
      } catch (sellerErr) {
        console.error('[PayPal] Crate seller payment processing error:', sellerErr);
      }
    }

    // Deduct applied credit from user's balance
    const userId = orderData.customer?.userId;
    if (appliedCredit > 0 && userId) {
      console.log('[PayPal] Deducting applied credit:', appliedCredit, 'from user:', userId);
      try {
        const creditData = await getDocument('userCredits', userId);
        if (creditData && creditData.balance >= appliedCredit) {
          const newBalance = creditData.balance - appliedCredit;
          const now = new Date().toISOString();

          // Create transaction record
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

          const existingTransactions = creditData.transactions || [];
          existingTransactions.push(transaction);

          await updateDocument('userCredits', userId, {
            balance: newBalance,
            lastUpdated: now,
            transactions: existingTransactions
          });

          // Also update user document
          await updateDocument('users', userId, {
            creditBalance: newBalance,
            creditUpdatedAt: now
          });

          console.log('[PayPal] Credit deducted, new balance:', newBalance);
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
      error: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Process artist payments via Stripe Connect or PayPal
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  // Import PayPal payout functions
  const { createPayout, getPayPalConfig } = await import('../../../lib/paypal-payouts');
  const paypalConfig = getPayPalConfig(env);

  try {
    // Group items by artist
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      stripeConnectId: string | null;
      paypalEmail: string | null;
      payoutMethod: string | null;
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
      // PayPal fee: 1.4% + £0.20 (split fixed fee across items)
      const paypalFee = (itemTotal * 0.014) + (0.20 / items.length);
      const artistShare = itemTotal - freshWaxFee - paypalFee;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          stripeConnectId: artist?.stripeConnectId || null,
          paypalEmail: artist?.paypalEmail || null,
          payoutMethod: artist?.payoutMethod || null,
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    console.log('[PayPal] Artist payments to process:', Object.keys(artistPayments).length);

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      console.log('[PayPal] Processing payment for', payment.artistName, ':', payment.amount, 'GBP');

      // Determine payout method - respect artist preference
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.payoutMethod === 'stripe' && payment.stripeConnectId;
      // If no preference set, default to whatever is available (Stripe first)
      const defaultToStripe = !payment.payoutMethod && payment.stripeConnectId;
      const defaultToPayPal = !payment.payoutMethod && !payment.stripeConnectId && payment.paypalEmail && paypalConfig;

      if (usePayPal || defaultToPayPal) {
        // Pay via PayPal - deduct 2% payout fee from artist share
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        console.log('[PayPal] Paying', payment.artistName, '£' + paypalAmount.toFixed(2), 'via PayPal (2% fee: £' + paypalPayoutFee.toFixed(2) + ')');

        try {
          const paypalResult = await createPayout(paypalConfig!, {
            email: payment.paypalEmail!,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax payout for order ${orderNumber}`,
            reference: `${orderId}-${payment.artistId}`
          });

          if (paypalResult.success) {
            await addDocument('payouts', {
              artistId: payment.artistId,
              artistName: payment.artistName,
              artistEmail: payment.artistEmail,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: paypalResult.batchId,
              paypalPayoutItemId: paypalResult.payoutItemId,
              orderId,
              orderNumber,
              amount: paypalAmount,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              payoutMethod: 'paypal',
              customerPaymentMethod: 'paypal',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            const artist = await getDocument('artists', payment.artistId);
            if (artist) {
              await updateDocument('artists', payment.artistId, {
                totalEarnings: (artist.totalEarnings || 0) + paypalAmount,
                lastPayoutAt: new Date().toISOString()
              });
            }

            console.log('[PayPal] ✓ PayPal payout created:', paypalResult.batchId);
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: any) {
          console.error('[PayPal] PayPal payout failed:', paypalError.message);

          await addDocument('pendingPayouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            artistEmail: payment.artistEmail,
            paypalEmail: payment.paypalEmail,
            orderId,
            orderNumber,
            amount: paypalAmount,
            paypalPayoutFee: paypalPayoutFee,
            currency: 'gbp',
            status: 'retry_pending',
            failureReason: paypalError.message,
            payoutMethod: 'paypal',
            customerPaymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

      } else if (useStripe || defaultToStripe) {
        // Pay via Stripe Connect
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100),
            currency: 'gbp',
            destination: payment.stripeConnectId!,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              artistId: payment.artistId,
              artistName: payment.artistName,
              platform: 'freshwax',
              customerPaymentMethod: 'paypal'
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
            payoutMethod: 'stripe',
            customerPaymentMethod: 'paypal',
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

          console.log('[PayPal] ✓ Stripe transfer created:', transfer.id);

        } catch (transferError: any) {
          console.error('[PayPal] Stripe transfer failed:', transferError.message);

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
            payoutMethod: 'stripe',
            customerPaymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        // Artist not connected to any payout method - store as pending
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
          customerPaymentMethod: 'paypal',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Update artist's pending balance
        try {
          const artist = await getDocument('artists', payment.artistId);
          if (artist) {
            await updateDocument('artists', payment.artistId, {
              pendingBalance: (artist.pendingBalance || 0) + payment.amount,
              updatedAt: new Date().toISOString()
            });
          }
        } catch (e) {
          console.log('[PayPal] Could not update artist pending balance');
        }
      }
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
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, stripeSecretKey, env } = params;
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
      const paypalFee = (itemTotal * 0.014) + (0.20 / merchItems.length);
      const supplierShare = itemTotal - freshWaxFee - paypalFee;

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

            const supplier = await getDocument('merch-suppliers', payment.supplierId);
            if (supplier) {
              await updateDocument('merch-suppliers', payment.supplierId, {
                totalEarnings: (supplier.totalEarnings || 0) + paypalAmount,
                lastPayoutAt: new Date().toISOString()
              });
            }

            console.log('[PayPal] ✓ Supplier PayPal payout created:', paypalResult.batchId);
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: any) {
          console.error('[PayPal] Supplier PayPal payout failed:', paypalError.message);

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
            failureReason: paypalError.message,
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

          const supplier = await getDocument('merch-suppliers', payment.supplierId);
          if (supplier) {
            await updateDocument('merch-suppliers', payment.supplierId, {
              totalEarnings: (supplier.totalEarnings || 0) + payment.amount,
              lastPayoutAt: new Date().toISOString()
            });
          }

          console.log('[PayPal] ✓ Supplier Stripe transfer created:', transfer.id);

        } catch (transferError: any) {
          console.error('[PayPal] Supplier transfer failed:', transferError.message);

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
            failureReason: transferError.message,
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
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, stripeSecretKey, env } = params;
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
      const paypalFee = (itemTotal * 0.014) + (0.20 / crateItems.length);
      const sellerShare = itemTotal - freshWaxFee - paypalFee;

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

            const sellerUser = await getDocument('users', payment.sellerId);
            if (sellerUser) {
              await updateDocument('users', payment.sellerId, {
                crateEarnings: (sellerUser.crateEarnings || 0) + paypalAmount,
                lastCratePayoutAt: new Date().toISOString()
              });
            }

            console.log('[PayPal] ✓ Crate seller PayPal payout created:', paypalResult.batchId);
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: any) {
          console.error('[PayPal] Crate seller PayPal payout failed:', paypalError.message);

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
            failureReason: paypalError.message,
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

          const sellerUser = await getDocument('users', payment.sellerId);
          if (sellerUser) {
            await updateDocument('users', payment.sellerId, {
              crateEarnings: (sellerUser.crateEarnings || 0) + payment.amount,
              lastCratePayoutAt: new Date().toISOString()
            });
          }

          console.log('[PayPal] ✓ Crate seller Stripe transfer created:', transfer.id);

        } catch (transferError: any) {
          console.error('[PayPal] Crate seller transfer failed:', transferError.message);

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
            failureReason: transferError.message,
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
