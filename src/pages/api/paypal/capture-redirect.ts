// src/pages/api/paypal/capture-redirect.ts
// Handles PayPal redirect after customer approves payment
// Captures the payment and redirects to order confirmation

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
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

export const GET: APIRoute = async ({ request, locals, redirect }) => {
  const url = new URL(request.url);
  const paypalOrderId = url.searchParams.get('token');
  const payerId = url.searchParams.get('PayerID');

  console.log('[PayPal Redirect] Token:', paypalOrderId, 'PayerID:', payerId);

  if (!paypalOrderId) {
    console.error('[PayPal Redirect] No token in URL');
    return redirect('/checkout?error=missing_token');
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
      console.error('[PayPal Redirect] PayPal not configured');
      return redirect('/checkout?error=config');
    }

    // Retrieve order data from Firebase (stored when order was created)
    const pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
    if (!pendingOrder) {
      console.error('[PayPal Redirect] No pending order found for:', paypalOrderId);
      return redirect('/checkout?error=order_not_found');
    }

    console.log('[PayPal Redirect] Found pending order, capturing...');

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
      console.error('[PayPal Redirect] Capture error:', error);
      return redirect('/checkout?error=capture_failed');
    }

    const captureResult = await captureResponse.json();
    console.log('[PayPal Redirect] Capture result:', captureResult.status);

    // Verify payment was captured successfully
    if (captureResult.status !== 'COMPLETED') {
      console.error('[PayPal Redirect] Payment not completed:', captureResult.status);
      return redirect('/checkout?error=payment_' + captureResult.status.toLowerCase());
    }

    // Get capture details
    const capture = captureResult.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id;

    console.log('[PayPal Redirect] Payment captured:', captureId);

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
      console.error('[PayPal Redirect] Order creation failed:', result.error);
      return redirect('/checkout?error=order_creation');
    }

    console.log('[PayPal Redirect] Order created:', result.orderNumber);

    // Clean up pending order
    try {
      await deleteDocument('pendingPayPalOrders', paypalOrderId);
    } catch (delErr) {
      console.log('[PayPal Redirect] Could not delete pending order:', delErr);
    }

    // Process artist payments via Stripe Connect (same as capture-order.ts)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      try {
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: pendingOrder.items,
          stripeSecretKey,
          env
        });
      } catch (paymentErr) {
        console.error('[PayPal Redirect] Artist payment processing error:', paymentErr);
      }

      // Process merch supplier payments
      try {
        await processMerchSupplierPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: pendingOrder.items,
          stripeSecretKey,
          env
        });
      } catch (supplierErr) {
        console.error('[PayPal Redirect] Supplier payment processing error:', supplierErr);
      }

      // Process vinyl crate seller payments
      try {
        await processVinylCrateSellerPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: pendingOrder.items,
          stripeSecretKey,
          env
        });
      } catch (sellerErr) {
        console.error('[PayPal Redirect] Crate seller payment processing error:', sellerErr);
      }
    }

    // Deduct applied credit from user's balance
    const userId = pendingOrder.customer?.userId;
    const appliedCredit = pendingOrder.appliedCredit || pendingOrder.totals?.appliedCredit || 0;
    if (appliedCredit > 0 && userId) {
      console.log('[PayPal Redirect] Deducting applied credit:', appliedCredit, 'from user:', userId);
      try {
        const creditData = await getDocument('userCredits', userId);
        if (creditData && creditData.balance >= appliedCredit) {
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

          const existingTransactions = creditData.transactions || [];
          existingTransactions.push(transaction);

          await updateDocument('userCredits', userId, {
            balance: newBalance,
            lastUpdated: now,
            transactions: existingTransactions
          });

          await updateDocument('users', userId, {
            creditBalance: newBalance,
            creditUpdatedAt: now
          });

          console.log('[PayPal Redirect] Credit deducted, new balance:', newBalance);
        }
      } catch (creditErr) {
        console.error('[PayPal Redirect] Failed to deduct credit:', creditErr);
      }
    }

    // Redirect to order confirmation
    return redirect(`/order-confirmation/${result.orderId}`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PayPal Redirect] Error:', errorMessage);
    return redirect('/checkout?error=unknown');
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
        console.log('[PayPal Redirect] Could not find artist:', artistId);
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

    console.log('[PayPal Redirect] Artist payments to process:', Object.keys(artistPayments).length);

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      console.log('[PayPal Redirect] Processing payment for', payment.artistName, ':', payment.amount, 'GBP');

      // Determine payout method - respect artist preference
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.payoutMethod === 'stripe' && payment.stripeConnectId;
      const defaultToStripe = !payment.payoutMethod && payment.stripeConnectId;
      const defaultToPayPal = !payment.payoutMethod && !payment.stripeConnectId && payment.paypalEmail && paypalConfig;

      if (usePayPal || defaultToPayPal) {
        // Pay via PayPal - deduct 2% payout fee from artist share
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        console.log('[PayPal Redirect] Paying', payment.artistName, '£' + paypalAmount.toFixed(2), 'via PayPal');

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

            console.log('[PayPal Redirect] ✓ PayPal payout created:', paypalResult.batchId);
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: any) {
          console.error('[PayPal Redirect] PayPal payout failed:', paypalError.message);

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

          console.log('[PayPal Redirect] ✓ Stripe transfer created:', transfer.id);

        } catch (transferError: any) {
          console.error('[PayPal Redirect] Stripe transfer failed:', transferError.message);

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
        // Artist not connected to any payout method - store as pending and update pendingBalance
        console.log('[PayPal Redirect] Artist', payment.artistName, 'not connected - storing pending');

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
          console.log('[PayPal Redirect] Could not update artist pending balance');
        }
      }
    }
  } catch (error) {
    console.error('[PayPal Redirect] processArtistPayments error:', error);
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
    const merchItems = items.filter(item => item.type === 'merch');

    if (merchItems.length === 0) {
      console.log('[PayPal Redirect] No merch items in order - skipping supplier payments');
      return;
    }

    console.log('[PayPal Redirect] Processing', merchItems.length, 'merch items for supplier payments');

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

    const merchCache: Record<string, any> = {};

    for (const item of merchItems) {
      const productId = item.productId || item.merchId || item.id;
      if (!productId) continue;

      let product = merchCache[productId];
      if (!product) {
        product = await getDocument('merch', productId);
        if (product) merchCache[productId] = product;
      }

      if (!product) continue;

      const supplierId = product.supplierId;
      if (!supplierId) continue;

      let supplier = null;
      try {
        supplier = await getDocument('merch-suppliers', supplierId);
      } catch (e) {
        console.log('[PayPal Redirect] Could not find supplier:', supplierId);
      }

      if (!supplier) continue;

      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.05;
      const paypalFee = (itemTotal * 0.014) + (0.20 / merchItems.length);
      const supplierShare = itemTotal - freshWaxFee - paypalFee;

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

    console.log('[PayPal Redirect] Supplier payments to process:', Object.keys(supplierPayments).length);

    for (const supplierId of Object.keys(supplierPayments)) {
      const payment = supplierPayments[supplierId];
      if (payment.amount <= 0) continue;

      console.log('[PayPal Redirect] Processing payment for supplier', payment.supplierName, ':', payment.amount.toFixed(2), 'GBP');

      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

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
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }
        } catch (paypalError: any) {
          console.error('[PayPal Redirect] Supplier PayPal payout failed:', paypalError.message);
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
        } catch (transferError: any) {
          console.error('[PayPal Redirect] Supplier transfer failed:', transferError.message);
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
        console.log('[PayPal Redirect] Supplier', payment.supplierName, 'not connected - storing pending');
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
    console.error('[PayPal Redirect] processMerchSupplierPayments error:', error);
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
    const crateItems = items.filter(item =>
      item.type === 'crate' ||
      item.type === 'vinyl-crate' ||
      item.crateListingId ||
      item.sellerId
    );

    if (crateItems.length === 0) {
      console.log('[PayPal Redirect] No vinyl crate items in order - skipping seller payments');
      return;
    }

    console.log('[PayPal Redirect] Processing', crateItems.length, 'vinyl crate items for seller payments');

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

    const listingCache: Record<string, any> = {};

    for (const item of crateItems) {
      let sellerId = item.sellerId;
      let listingId = item.crateListingId || item.listingId;

      if (!sellerId && listingId) {
        let listing = listingCache[listingId];
        if (!listing) {
          listing = await getDocument('crateListings', listingId);
          if (listing) listingCache[listingId] = listing;
        }
        if (listing) sellerId = listing.sellerId || listing.userId;
      }

      if (!sellerId) continue;

      let seller = null;
      try {
        seller = await getDocument('users', sellerId);
      } catch (e) {
        console.log('[PayPal Redirect] Could not find seller user:', sellerId);
      }

      if (!seller) continue;

      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      const paypalFee = (itemTotal * 0.014) + (0.20 / crateItems.length);
      const sellerShare = itemTotal - freshWaxFee - paypalFee;

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

    console.log('[PayPal Redirect] Vinyl crate seller payments to process:', Object.keys(sellerPayments).length);

    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];
      if (payment.amount <= 0) continue;

      console.log('[PayPal Redirect] Processing payment for seller', payment.sellerName, ':', payment.amount.toFixed(2), 'GBP');

      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

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
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }
        } catch (paypalError: any) {
          console.error('[PayPal Redirect] Crate seller PayPal payout failed:', paypalError.message);
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
        } catch (transferError: any) {
          console.error('[PayPal Redirect] Crate seller transfer failed:', transferError.message);
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
        console.log('[PayPal Redirect] Crate seller', payment.sellerName, 'not connected - storing pending');
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
    console.error('[PayPal Redirect] processVinylCrateSellerPayments error:', error);
    throw error;
  }
}
