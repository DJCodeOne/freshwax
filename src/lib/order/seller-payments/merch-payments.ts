// src/lib/order/seller-payments/merch-payments.ts
// Handles merch supplier payouts via Stripe Connect or PayPal

import Stripe from 'stripe';
import { getDocument, addDocument, updateDocument, atomicIncrement } from '../../firebase-rest';
import { createLogger } from '../../api-utils';
import type { SellerPaymentParams } from './types';

const log = createLogger('[seller-payments]');

// Process merch supplier payments via Stripe Connect or PayPal
// Based on capture-redirect.ts version (superset with Stripe Connect transfers)
// Pass skipStripeTransfers: true to skip actual Stripe/PayPal transfers (royalty-only mode)
export async function processMerchSupplierPayments(params: SellerPaymentParams & { skipStripeTransfers?: boolean }) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env, skipStripeTransfers } = params;
  const prefix = params.logPrefix || '[PayPal]';

  const stripe = skipStripeTransfers ? null : new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../../paypal-payouts');
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
