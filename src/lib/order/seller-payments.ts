// src/lib/order/seller-payments.ts
// Shared seller payment processing functions extracted from capture-order.ts and capture-redirect.ts
// Handles artist royalties, merch supplier payouts, and vinyl crate seller payouts

import Stripe from 'stripe';
import { getDocument, addDocument, updateDocument, atomicIncrement } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('[seller-payments]');

/** Params shared by all seller payment functions */
export interface SellerPaymentParams {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
  /** Optional log prefix override (e.g. '[PayPal]' or '[PayPal Redirect]') */
  logPrefix?: string;
}

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
export async function processArtistPayments(params: SellerPaymentParams) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal } = params;
  const prefix = params.logPrefix || '[PayPal]';

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
        log.warn(`${prefix} Could not update artist pending balance`);
      }

      // Pending payout created
    }
  } catch (error: unknown) {
    log.error(`${prefix} processArtistPayments error:`, error);
    throw error;
  }
}

// Process merch supplier payments via Stripe Connect or PayPal
// Based on capture-redirect.ts version (superset with Stripe Connect transfers)
// Pass skipStripeTransfers: true to skip actual Stripe/PayPal transfers (royalty-only mode)
export async function processMerchSupplierPayments(params: SellerPaymentParams & { skipStripeTransfers?: boolean }) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env, skipStripeTransfers } = params;
  const prefix = params.logPrefix || '[PayPal]';

  const stripe = skipStripeTransfers ? null : new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../paypal-payouts');
  const paypalConfig = skipStripeTransfers ? null : getPayPalConfig(env);

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

    if (skipStripeTransfers) {
      // Skip actual transfers - supplier payment records will not be created
      return;
    }

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
          log.error(`${prefix} Supplier PayPal payout failed:`, paypalMessage);
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
          const transfer = await stripe!.transfers.create({
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
          log.error(`${prefix} Supplier transfer failed:`, transferMessage);
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
    log.error(`${prefix} processMerchSupplierPayments error:`, error);
    throw error;
  }
}

// Process vinyl crate seller payments via Stripe Connect or PayPal
export async function processVinylCrateSellerPayments(params: SellerPaymentParams) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const prefix = params.logPrefix || '[PayPal]';
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../paypal-payouts');
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

      if (!sellerId) {
        // No seller ID for crate item
        continue;
      }

      const seller = sellerMap.get(sellerId) || null;
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
          log.error(`${prefix} Crate seller PayPal payout failed:`, paypalMessage);

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
          log.error(`${prefix} Crate seller transfer failed:`, transferMessage);

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
    log.error(`${prefix} processVinylCrateSellerPayments error:`, error);
    throw error;
  }
}
