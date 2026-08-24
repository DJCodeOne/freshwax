// src/pages/api/admin/trigger-payout.ts
// Admin-triggered PayPal payout for ONE payee of one order. Rebuilt Aug
// 2026: for artists the payable pendingPayouts row is the authority for the
// amount (the old version trusted the client and recomputed shares from
// order items), the PayPal email must be explicit (the old version fell
// back to the payee's ACCOUNT email — money sent to an address with no
// PayPal account floats unclaimed for 30 days), and settlement runs through
// lib/payout-settlement so history records and balances stay exact. The
// artist bears the 2% PayPal payout fee, as advertised on their payouts
// page. Stripe payouts have their own button (send-stripe-payout).

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, addDocument, queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { createPayout, getPayPalConfig } from '../../../lib/paypal-payouts';
import { settlePendingArtistRows } from '../../../lib/payout-settlement';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/trigger-payout');

const triggerPayoutSchema = z.object({
  orderId: z.string().min(1),
  payeeType: z.enum(['artist', 'supplier', 'seller']),
  payeeId: z.string().min(1),
  payeeName: z.string().max(200).optional(),
  paypalEmail: z.string().email(),
  adminKey: z.string().max(500).optional(),
  idToken: z.string().max(5000).optional(),
}).strip();

const PAYABLE_STATUSES = ['pending', 'awaiting_connect', 'retry_pending'];

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime.env;
    const bodyData = await request.json();

    const authError = await requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`admin-payout:${clientId}`, RateLimiters.write);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    const parsed = triggerPayoutSchema.safeParse(bodyData);
    if (!parsed.success) {
      return ApiErrors.badRequest('orderId, payeeType, payeeId and paypalEmail are required');
    }
    const { orderId, payeeType, payeeId, payeeName, paypalEmail } = parsed.data;

    const order = await getDocument('orders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    const paypalConfig = getPayPalConfig(env);
    if (!paypalConfig) {
      return ApiErrors.serverError('PayPal not configured');
    }

    // ------------------------------------------------------------------
    // Artists: the pendingPayouts row is the authority for the amount.
    // ------------------------------------------------------------------
    if (payeeType === 'artist') {
      const rows = await queryCollection('pendingPayouts', {
        filters: [
          { field: 'orderId', op: 'EQUAL', value: orderId },
          { field: 'artistId', op: 'EQUAL', value: payeeId },
          { field: 'status', op: 'IN', value: PAYABLE_STATUSES },
        ],
        limit: 5,
      });
      const grossAmount = rows.reduce((s: number, r: Record<string, unknown>) => s + (Number(r.amount) || 0), 0);
      if (rows.length === 0 || grossAmount <= 0) {
        return ApiErrors.badRequest('Nothing payable for this artist on this order');
      }

      // Artist bears the 2% PayPal payout fee (as shown on their payouts page)
      const paypalPayoutFee = Math.round(grossAmount * 0.02 * 100) / 100;
      const paypalNetAmount = Math.round((grossAmount - paypalPayoutFee) * 100) / 100;

      const payoutResult = await createPayout(paypalConfig, {
        email: paypalEmail,
        amount: paypalNetAmount,
        currency: 'GBP',
        note: `Fresh Wax payout for order ${order.orderNumber}`,
        reference: `${orderId}-artist-${payeeId}`
      });

      if (!payoutResult.success) {
        return ApiErrors.serverError(payoutResult.error || 'PayPal payout failed');
      }

      // Settle the rows — history record from the row, balances kept in sync.
      const settlement = await settlePendingArtistRows({
        orderId,
        artistId: payeeId,
        method: 'paypal',
        notes: `PayPal payout to ${paypalEmail}`,
        triggeredBy: 'admin',
        extra: {
          paypalEmail,
          paypalBatchId: payoutResult.batchId,
          paypalPayoutItemId: payoutResult.payoutItemId,
          paypalPayoutFee,
          paypalNetAmount,
        },
      });

      log.info(`PayPal payout: £${paypalNetAmount} (gross £${grossAmount}) → ${payeeName || payeeId} [${payoutResult.batchId}]`);

      return successResponse({
        payee: payeeName || payeeId,
        grossAmount,
        paypalPayoutFee,
        amount: paypalNetAmount,
        settled: settlement.settled,
        batchId: payoutResult.batchId,
        message: `Sent £${paypalNetAmount.toFixed(2)} via PayPal (£${paypalPayoutFee.toFixed(2)} PayPal fee)`,
      });
    }

    // ------------------------------------------------------------------
    // Suppliers / crate sellers: their pending rows live in separate
    // collections with the same amount semantics.
    // ------------------------------------------------------------------
    const pendingCollection = payeeType === 'supplier' ? 'pendingSupplierPayouts' : 'pendingCrateSellerPayouts';
    const idField = payeeType === 'supplier' ? 'supplierId' : 'sellerId';

    const rows = await queryCollection(pendingCollection, {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: idField, op: 'EQUAL', value: payeeId },
        { field: 'status', op: 'IN', value: PAYABLE_STATUSES },
      ],
      limit: 5,
    });
    const grossAmount = rows.reduce((s: number, r: Record<string, unknown>) => s + (Number(r.amount) || 0), 0);
    if (rows.length === 0 || grossAmount <= 0) {
      return ApiErrors.badRequest('Nothing payable for this payee on this order');
    }

    const paypalPayoutFee = Math.round(grossAmount * 0.02 * 100) / 100;
    const paypalNetAmount = Math.round((grossAmount - paypalPayoutFee) * 100) / 100;

    const payoutResult = await createPayout(paypalConfig, {
      email: paypalEmail,
      amount: paypalNetAmount,
      currency: 'GBP',
      note: `Fresh Wax ${payeeType} payout for order ${order.orderNumber}`,
      reference: `${orderId}-${payeeType}-${payeeId}`
    });

    if (!payoutResult.success) {
      return ApiErrors.serverError(payoutResult.error || 'PayPal payout failed');
    }

    const now = new Date().toISOString();
    const payoutCollection = payeeType === 'supplier' ? 'supplierPayouts' : 'crateSellerPayouts';
    await addDocument(payoutCollection, {
      ...(payeeType === 'supplier'
        ? { supplierId: payeeId, supplierName: payeeName || '' }
        : { sellerId: payeeId, sellerName: payeeName || '' }),
      entityType: payeeType,
      paypalEmail,
      paypalBatchId: payoutResult.batchId,
      paypalPayoutItemId: payoutResult.payoutItemId,
      orderId,
      orderNumber: order.orderNumber,
      amount: grossAmount,
      paypalPayoutFee,
      paypalNetAmount,
      currency: 'gbp',
      status: 'completed',
      payoutMethod: 'paypal',
      triggeredBy: 'admin',
      createdAt: now,
      updatedAt: now,
      completedAt: now
    });
    for (const row of rows) {
      await updateDocument(pendingCollection, row.id as string, {
        status: 'completed',
        payoutMethod: 'paypal',
        paypalBatchId: payoutResult.batchId,
        completedBy: 'admin',
        completedAt: now,
        updatedAt: now
      });
    }

    return successResponse({
      payee: payeeName || payeeId,
      grossAmount,
      paypalPayoutFee,
      amount: paypalNetAmount,
      batchId: payoutResult.batchId,
      message: `Sent £${paypalNetAmount.toFixed(2)} via PayPal (£${paypalPayoutFee.toFixed(2)} PayPal fee)`,
    });

  } catch (error: unknown) {
    log.error('Trigger payout error:', error);
    return ApiErrors.serverError('Failed to trigger payout');
  }
};
