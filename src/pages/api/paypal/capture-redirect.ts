// src/pages/api/paypal/capture-redirect.ts
// Handles PayPal redirect after customer approves payment
// Captures the payment and redirects to order confirmation

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { createOrder } from '../../../lib/order-utils';
import { getDocument, deleteDocument, addDocument, updateDocument, atomicIncrement, arrayUnion, queryCollection } from '../../../lib/firebase-rest';
import { SITE_URL } from '../../../lib/constants';
import { createLogger, fetchWithTimeout } from '../../../lib/api-utils';

const log = createLogger('[paypal-redirect]');
import { getPayPalBaseUrl, getPayPalAccessToken } from '../../../lib/paypal-auth';

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

    // IDEMPOTENCY CHECK: If an order with this PayPal ID already exists, redirect to success
    // Prevents duplicate orders from browser back-button or double-click
    try {
      const existingOrders = await queryCollection('orders', {
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
        limit: 1
      }, true);
      if (existingOrders && existingOrders.length > 0) {
        log.info('[PayPal Redirect] Order already exists for paypalOrderId:', paypalOrderId);
        return redirect(`${SITE_URL}/order-confirmation/${existingOrders[0].id}`);
      }
    } catch (idempotencyErr: unknown) {
      log.error('[PayPal Redirect] Idempotency check failed (Firebase unreachable):', idempotencyErr);
      // Don't proceed if we can't verify — customer can retry
      return redirect('/checkout?error=service_unavailable');
    }

    // Retrieve order data from Firebase (stored when order was created)
    const pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
    if (!pendingOrder) {
      log.error('[PayPal Redirect] No pending order found for:', paypalOrderId);
      return redirect('/checkout?error=order_not_found');
    }

    // Found pending order, capturing

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

      try {
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: pendingOrder.items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      } catch (paymentErr: unknown) {
        log.error('[PayPal Redirect] Artist payment processing error:', paymentErr);
      }

      // Process merch supplier payments
      try {
        await processMerchSupplierPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: pendingOrder.items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      } catch (supplierErr: unknown) {
        log.error('[PayPal Redirect] Supplier payment processing error:', supplierErr);
      }

      // Process vinyl crate seller payments
      try {
        await processVinylCrateSellerPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items: pendingOrder.items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      } catch (sellerErr: unknown) {
        log.error('[PayPal Redirect] Crate seller payment processing error:', sellerErr);
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

          // Atomic arrayUnion prevents lost transactions under concurrent writes
          await arrayUnion('userCredits', userId, 'transactions', [transaction], {
            lastUpdated: now
          });

          await atomicIncrement('users', userId, { creditBalance: -appliedCredit });

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

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
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

    // Collect unique release IDs
    const releaseIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (releaseId) releaseIds.add(releaseId as string);
    }

    // Batch-fetch all releases in parallel
    const releaseEntries = await Promise.all(
      [...releaseIds].map(async (id) => {
        const doc = await getDocument('releases', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const releaseMap = new Map(releaseEntries.filter(([, doc]) => doc));

    // Collect unique artist IDs from resolved releases
    const artistIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;
      const release = releaseMap.get(releaseId as string);
      if (!release) continue;
      const aid = item.artistId || release.artistId || release.userId;
      if (aid) artistIds.add(aid as string);
    }

    // Batch-fetch all artists in parallel
    const artistEntries = await Promise.all(
      [...artistIds].map(async (id) => {
        const doc = await getDocument('artists', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const artistMap = new Map(artistEntries.filter(([, doc]) => doc));

    for (const item of items) {
      // Skip merch items - they go to suppliers
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      const release = releaseMap.get(releaseId as string);
      if (!release) continue;

      const artistId = (item.artistId || release.artistId || release.userId) as string;
      if (!artistId) continue;

      const artist = artistMap.get(artistId) || null;

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
      } catch (e: unknown) {
        log.warn('[PayPal Redirect] Could not update artist pending balance');
      }

      // Pending payout created
    }
  } catch (error: unknown) {
    log.error('[PayPal Redirect] processArtistPayments error:', error);
    throw error;
  }
}

// Process merch supplier payments via Stripe Connect or PayPal
async function processMerchSupplierPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../../../lib/paypal-payouts');
  const paypalConfig = getPayPalConfig(env);

  try {
    const merchItems = items.filter(item => item.type === 'merch');

    if (merchItems.length === 0) {
      // No merch items - skip supplier payments
      return;
    }

    // Processing merch supplier payments

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

    // Collect unique product IDs
    const productIds = new Set<string>();
    for (const item of merchItems) {
      const productId = item.productId || item.merchId || item.id;
      if (productId) productIds.add(productId as string);
    }

    // Batch-fetch all merch products in parallel
    const productEntries = await Promise.all(
      [...productIds].map(async (id) => {
        const doc = await getDocument('merch', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const productMap = new Map(productEntries.filter(([, doc]) => doc));

    // Collect unique supplier IDs from resolved products
    const supplierIds = new Set<string>();
    for (const item of merchItems) {
      const productId = item.productId || item.merchId || item.id;
      if (!productId) continue;
      const product = productMap.get(productId as string);
      if (!product) continue;
      if (product.supplierId) supplierIds.add(product.supplierId as string);
    }

    // Batch-fetch all suppliers in parallel
    const supplierEntries = await Promise.all(
      [...supplierIds].map(async (id) => {
        const doc = await getDocument('merch-suppliers', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const supplierMap = new Map(supplierEntries.filter(([, doc]) => doc));

    for (const item of merchItems) {
      const productId = item.productId || item.merchId || item.id;
      if (!productId) continue;

      const product = productMap.get(productId as string);
      if (!product) continue;

      const supplierId = product.supplierId as string;
      if (!supplierId) continue;

      const supplier = supplierMap.get(supplierId) || null;
      if (!supplier) continue;

      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.05;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const supplierShare = itemTotal - freshWaxFee - processingFeePerSeller;

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

    for (const supplierId of Object.keys(supplierPayments)) {
      const payment = supplierPayments[supplierId];
      if (payment.amount <= 0) continue;

      // Processing supplier payment

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

            // Atomically update supplier earnings
            await atomicIncrement('merch-suppliers', payment.supplierId, {
              totalEarnings: paypalAmount,
            });
            await updateDocument('merch-suppliers', payment.supplierId, {
              lastPayoutAt: new Date().toISOString()
            });
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }
        } catch (paypalError: unknown) {
          const paypalMessage = paypalError instanceof Error ? paypalError.message : String(paypalError);
          log.error('[PayPal Redirect] Supplier PayPal payout failed:', paypalMessage);
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

          // Atomically update supplier earnings
          await atomicIncrement('merch-suppliers', payment.supplierId, {
            totalEarnings: payment.amount,
          });
          await updateDocument('merch-suppliers', payment.supplierId, {
            lastPayoutAt: new Date().toISOString()
          });
        } catch (transferError: unknown) {
          const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
          log.error('[PayPal Redirect] Supplier transfer failed:', transferMessage);
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
    log.error('[PayPal Redirect] processMerchSupplierPayments error:', error);
    throw error;
  }
}

// Process vinyl crate seller payments via Stripe Connect or PayPal
async function processVinylCrateSellerPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
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
      // No vinyl crate items - skip seller payments
      return;
    }

    // Processing vinyl crate seller payments

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

    // Collect unique listing IDs that need fetching (items without a sellerId)
    const listingIds = new Set<string>();
    for (const item of crateItems) {
      if (!item.sellerId && (item.crateListingId || item.listingId)) {
        listingIds.add((item.crateListingId || item.listingId) as string);
      }
    }

    // Batch-fetch all crate listings in parallel
    const listingEntries = await Promise.all(
      [...listingIds].map(async (id) => {
        const doc = await getDocument('crateListings', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const listingMap = new Map(listingEntries.filter(([, doc]) => doc));

    // Resolve sellerIds for all crate items, then collect unique seller IDs
    const sellerIdSet = new Set<string>();
    const itemSellerIds: (string | null)[] = [];
    for (const item of crateItems) {
      let sellerId = item.sellerId as string | null;
      if (!sellerId) {
        const listingId = (item.crateListingId || item.listingId) as string | undefined;
        if (listingId) {
          const listing = listingMap.get(listingId);
          if (listing) {
            sellerId = (listing.sellerId || listing.userId) as string | null;
          }
        }
      }
      itemSellerIds.push(sellerId || null);
      if (sellerId) sellerIdSet.add(sellerId);
    }

    // Batch-fetch all sellers (users) in parallel
    const sellerEntries = await Promise.all(
      [...sellerIdSet].map(async (id) => {
        const doc = await getDocument('users', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const sellerMap = new Map(sellerEntries.filter(([, doc]) => doc));

    for (let i = 0; i < crateItems.length; i++) {
      const item = crateItems[i];
      const sellerId = itemSellerIds[i];

      if (!sellerId) continue;

      const seller = sellerMap.get(sellerId) || null;
      if (!seller) continue;

      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const sellerShare = itemTotal - freshWaxFee - processingFeePerSeller;

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

    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];
      if (payment.amount <= 0) continue;

      // Processing seller payment

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

            // Atomically update crate seller earnings
            await atomicIncrement('users', payment.sellerId, {
              crateEarnings: paypalAmount,
            });
            await updateDocument('users', payment.sellerId, {
              lastCratePayoutAt: new Date().toISOString()
            });
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }
        } catch (paypalError: unknown) {
          const paypalMessage = paypalError instanceof Error ? paypalError.message : String(paypalError);
          log.error('[PayPal Redirect] Crate seller PayPal payout failed:', paypalMessage);
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
        } catch (transferError: unknown) {
          const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
          log.error('[PayPal Redirect] Crate seller transfer failed:', transferMessage);
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
    log.error('[PayPal Redirect] processVinylCrateSellerPayments error:', error);
    throw error;
  }
}
