// src/pages/api/admin/record-payout.ts
// Admin endpoint to record a manual payout (when artist has already been paid outside the system)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { getDocument } from '../../../lib/firebase-rest';
import { saSetDocument, saQueryCollection, saDeleteDocument, saUpdateDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { formatPrice } from '../../../lib/format-utils';

const log = createLogger('[record-payout]');

const recordPayoutSchema = z.object({
  orderId: z.string().min(1),
  notes: z.string().optional(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`record-payout:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
    const bodyData = await request.json();

    // Admin auth required
    const authError = await requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;

    const serviceAccountKey = getServiceAccountKey(env);
    if (!serviceAccountKey) {
      return ApiErrors.serverError('Firebase service account not configured');
    }

    const parsed = recordPayoutSchema.safeParse(bodyData);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { orderId, notes } = parsed.data;

    // Get order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    log.info('[admin] Recording manual payout for order:', order.orderNumber || orderId);

    // Calculate artist payments from order items
    const items = order.items || [];
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      amount: number;
      items: string[];
    }> = {};

    for (const item of items) {
      // Skip merch items
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      const artistId = item.artistId || item.artist || 'unknown';
      const artistName = item.artist || item.artistName || 'Unknown Artist';
      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Calculate artist share (subtract platform fees)
      const freshWaxFee = itemTotal * 0.01;
      const processorFeePercent = 0.014;
      const processorFixedFee = 0.20 / items.length;
      const processorFee = (itemTotal * processorFeePercent) + processorFixedFee;
      const artistShare = itemTotal - freshWaxFee - processorFee;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName,
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || 'Item');
    }

    const results: Record<string, unknown>[] = [];

    for (const payment of Object.values(artistPayments)) {
      // Skip payments with zero or negative amounts (fees exceed item price)
      if (payment.amount <= 0) continue;

      // Record the payout as completed (manual) using service account auth
      const payoutId = `manual_${orderId}_${Date.now()}`;
      await saSetDocument(
        serviceAccountKey,
        projectId,
        'payouts',
        payoutId,
        {
          artistId: payment.artistId,
          artistName: payment.artistName,
          orderId,
          orderNumber: order.orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'completed',
          payoutMethod: 'manual',
          triggeredBy: 'admin',
          notes: notes || 'Manual payout recorded by admin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        }
      );

      results.push({
        artistId: payment.artistId,
        artistName: payment.artistName,
        amount: payment.amount,
        status: 'recorded'
      });

      log.info('[admin] ✓ Recorded manual payout for', payment.artistName, formatPrice(payment.amount));
    }

    // If no artist payouts were created (e.g., all items are low-value/merch),
    // create a "cleared" record to mark the order as handled
    if (results.length === 0) {
      const clearedPayoutId = `cleared_${orderId}_${Date.now()}`;
      await saSetDocument(
        serviceAccountKey,
        projectId,
        'payouts',
        clearedPayoutId,
        {
          artistId: 'none',
          artistName: 'Order Cleared',
          orderId,
          orderNumber: order.orderNumber,
          amount: 0,
          currency: 'gbp',
          status: 'completed',
          payoutMethod: 'cleared',
          triggeredBy: 'admin',
          notes: notes || 'Order cleared by admin - no artist payout required',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        }
      );
      results.push({
        artistId: 'none',
        artistName: 'Order Cleared',
        amount: 0,
        status: 'cleared'
      });
      log.info('[admin] ✓ Created cleared record for order', order.orderNumber);
    }

    // Also remove/update any pending payout records for this order
    // This prevents the order from reappearing in the queue
    try {
      const pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
        filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
        limit: 50
      });

      for (const pending of pendingPayouts) {
        // Update the pending payout to mark it as completed (or delete it)
        await saUpdateDocument(serviceAccountKey, projectId, 'pendingPayouts', pending.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          completedBy: 'admin_manual',
          notes: notes || 'Marked as paid by admin'
        });
        log.info('[admin] ✓ Updated pending payout', pending.id, 'to completed');
      }
    } catch (err: unknown) {
      log.error('[admin] Error updating pending payouts:', err);
      // Don't fail the request - the payout record was still created
    }

    return successResponse({ orderId,
      orderNumber: order.orderNumber,
      payouts: results,
      message: `Recorded ${results.length} payout(s)` });

  } catch (error: unknown) {
    log.error('[admin] Record payout error:', error);
    return ApiErrors.serverError('Failed to record payout');
  }
};
