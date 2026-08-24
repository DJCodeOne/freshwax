// src/pages/api/admin/record-payout.ts
// "Mark as Paid": records that the operator already paid a partner outside
// the system (PayPal/bank). Rebuilt Aug 2026 to settle the actual
// pendingPayouts rows (exact ids and amounts, postage included) instead of
// recomputing shares from order items — the old version cleared every
// payee's rows order-wide, never decremented pendingBalance, and filed
// history under artist NAMES because item.artistId is null on real orders.
// Pass artistId to mark just one partner paid on a multi-payee order.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { getDocument, queryCollection, addDocument } from '../../../lib/firebase-rest';
import { settlePendingArtistRows } from '../../../lib/payout-settlement';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('[record-payout]');

const recordPayoutSchema = z.object({
  orderId: z.string().min(1),
  artistId: z.string().min(1).max(200).optional(),
  notes: z.string().max(1000).optional(),
  adminKey: z.string().max(500).optional(),
  idToken: z.string().max(5000).optional(),
}).strip();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`record-payout:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const bodyData = await request.json();

    const authError = await requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    const parsed = recordPayoutSchema.safeParse(bodyData);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { orderId, artistId, notes } = parsed.data;

    const order = await getDocument('orders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    log.info(`[admin] Marking paid: order ${order.orderNumber || orderId}${artistId ? ` artist ${artistId}` : ' (all payees)'}`);

    const settlement = await settlePendingArtistRows({
      orderId,
      artistId,
      method: 'manual',
      notes: notes || 'Manual payout - already paid outside system',
      triggeredBy: 'admin_manual',
    });

    // Legacy orders (before pendingPayouts existed) have no rows but still sit
    // in the needs-payout queue — write a zero-amount "cleared" record so they
    // leave it. Never do this when scoped to one artist, and never duplicate
    // it when the order already has payout history.
    if (settlement.settled === 0 && !artistId) {
      const existing = await queryCollection('payouts', {
        filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
        limit: 1,
      });
      if (existing.length > 0) {
        return successResponse({
          orderId,
          orderNumber: order.orderNumber,
          settled: 0,
          message: 'Nothing payable — this order is already settled',
        });
      }
      const now = new Date().toISOString();
      await addDocument('payouts', {
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
        createdAt: now,
        updatedAt: now,
        completedAt: now
      });
      return successResponse({
        orderId,
        orderNumber: order.orderNumber,
        settled: 0,
        message: 'Order cleared — no payable rows existed',
      });
    }

    if (settlement.settled === 0) {
      return successResponse({
        orderId,
        orderNumber: order.orderNumber,
        settled: 0,
        message: 'Nothing payable for this partner on this order',
      });
    }

    return successResponse({
      orderId,
      orderNumber: order.orderNumber,
      settled: settlement.settled,
      totalAmount: Math.round(settlement.totalAmount * 100) / 100,
      skipped: settlement.skipped,
      payouts: settlement.artists,
      message: `Marked ${settlement.settled} payout(s) paid — £${settlement.totalAmount.toFixed(2)}${settlement.skipped ? ` (${settlement.skipped} row(s) skipped, see logs)` : ''}`,
    });

  } catch (error: unknown) {
    log.error('[admin] Record payout error:', error);
    return ApiErrors.serverError('Failed to record payout');
  }
};
