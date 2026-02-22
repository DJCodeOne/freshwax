// src/pages/api/admin/process-refund.ts
// Admin API endpoint to process Stripe refunds

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { getDocument, updateDocument, addDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
const log = createLogger('[process-refund]');
import { refundOrderStock } from '../../../lib/order-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const processRefundSchema = z.object({
  orderId: z.string().min(1),
  amount: z.union([z.number().positive(), z.literal('full'), z.null()]).optional(),
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
  refundItems: z.array(z.object({
    id: z.string().min(1),
  }).passthrough()).optional(),
  adminKey: z.string().optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`process-refund:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = locals.runtime.env;


  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return ApiErrors.serverError('Stripe not configured');
  }

  try {
    const parsed = processRefundSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { orderId, amount, reason, refundItems } = parsed.data;

    // Get order data
    const order = await getDocument('orders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    // Check if order has a payment intent
    const paymentIntentId = order.paymentIntentId;
    if (!paymentIntentId) {
      return ApiErrors.badRequest('Order has no payment intent - cannot refund');
    }

    // Check if already fully refunded
    if (order.refundStatus === 'full') {
      return ApiErrors.badRequest('Order already fully refunded');
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

    // Calculate refund amount
    const orderTotal = order.totals?.total || 0;
    const previouslyRefunded = order.refundedAmount || 0;
    const maxRefundable = Math.round((orderTotal - previouslyRefunded) * 100); // Convert to pence

    let refundAmountPence: number;
    let isFullRefund = false;

    if (amount === undefined || amount === null || amount === 'full') {
      // Full refund of remaining amount
      refundAmountPence = maxRefundable;
      isFullRefund = previouslyRefunded === 0;
    } else {
      // Partial refund
      refundAmountPence = Math.round(parseFloat(amount) * 100);
      if (refundAmountPence > maxRefundable) {
        return ApiErrors.badRequest('Refund amount exceeds maximum refundable (£${(maxRefundable / 100).toFixed(2)})');
      }
      isFullRefund = refundAmountPence === maxRefundable && previouslyRefunded === 0;
    }

    if (refundAmountPence <= 0) {
      return ApiErrors.badRequest('Invalid refund amount');
    }

    // Create Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: refundAmountPence,
      reason: reason === 'duplicate' ? 'duplicate' :
              reason === 'fraudulent' ? 'fraudulent' :
              'requested_by_customer',
      metadata: {
        orderId,
        orderNumber: order.orderNumber || '',
        adminRefund: 'true',
        platform: 'freshwax'
      }
    });

    const refundAmountPounds = refundAmountPence / 100;
    const totalRefunded = previouslyRefunded + refundAmountPounds;
    const newRefundStatus = totalRefunded >= orderTotal ? 'full' : 'partial';

    // Update order with refund info
    await updateDocument('orders', orderId, {
      refundStatus: newRefundStatus,
      refundedAmount: totalRefunded,
      lastRefundAt: new Date().toISOString(),
      lastRefundId: refund.id,
      updatedAt: new Date().toISOString()
    });

    // Record refund in refunds collection
    await addDocument('refunds', {
      orderId,
      orderNumber: order.orderNumber || '',
      stripeRefundId: refund.id,
      stripePaymentIntentId: paymentIntentId,
      amount: refundAmountPounds,
      currency: 'gbp',
      reason: reason || 'requested_by_customer',
      isFullRefund,
      refundItems: refundItems || null,
      customerEmail: order.customer?.email || '',
      customerName: `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
      status: 'completed',
      createdAt: new Date().toISOString()
    });

    // Restore stock if full refund or specific items refunded
    if (isFullRefund && order.items) {
      try {
        await refundOrderStock(orderId, order.items, order.orderNumber || orderId);
        log.info('[process-refund] Stock restored for full refund');
      } catch (stockErr: unknown) {
        log.error('[process-refund] Stock restore error:', stockErr);
      }
    } else if (refundItems && refundItems.length > 0) {
      // Partial refund with specific items
      try {
        const itemsToRefund = order.items.filter((item: Record<string, unknown>) =>
          refundItems.some((ri: Record<string, unknown>) => ri.id === item.id || ri.id === item.releaseId)
        );
        if (itemsToRefund.length > 0) {
          await refundOrderStock(orderId, itemsToRefund, order.orderNumber || orderId);
          log.info('[process-refund] Stock restored for refunded items');
        }
      } catch (stockErr: unknown) {
        log.error('[process-refund] Partial stock restore error:', stockErr);
      }
    }

    // Send refund confirmation email
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY && order.customer?.email) {
      try {
        await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <orders@freshwax.co.uk>',
            to: [order.customer.email],
            subject: `Refund processed for order ${order.orderNumber || orderId}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0a0a0a; padding: 40px; color: #fff;">
                <h1 style="color: #22c55e;">Refund Processed</h1>
                <p>Hi ${order.customer.firstName || 'there'},</p>
                <p>We've processed a ${isFullRefund ? 'full' : 'partial'} refund for your order <strong>${order.orderNumber || orderId}</strong>.</p>
                <div style="background-color: #1f1f1f; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <p style="margin: 0;"><strong>Refund Amount:</strong> £${refundAmountPounds.toFixed(2)}</p>
                  ${!isFullRefund ? `<p style="margin: 10px 0 0;"><strong>Total Refunded:</strong> £${totalRefunded.toFixed(2)}</p>` : ''}
                </div>
                <p>The refund will appear in your account within 5-10 business days depending on your bank.</p>
                <p style="color: #737373; font-size: 12px; margin-top: 30px;">Fresh Wax - Underground Music</p>
              </div>
            `
          })
        }, 10000);
        log.info('[process-refund] Refund email sent');
      } catch (emailErr: unknown) {
        log.error('[process-refund] Email error:', emailErr);
      }
    }

    return successResponse({ refundId: refund.id,
      amount: refundAmountPounds,
      totalRefunded,
      refundStatus: newRefundStatus,
      isFullRefund });

  } catch (error: unknown) {
    log.error('[process-refund] Error:', error);

    // Handle specific Stripe errors
    const stripeType = (error as Record<string, unknown>)?.type;
    if (stripeType === 'StripeCardError' || stripeType === 'StripeInvalidRequestError') {
      return ApiErrors.badRequest('Refund request failed');
    }

    return ApiErrors.serverError('Failed to process refund');
  }
};
