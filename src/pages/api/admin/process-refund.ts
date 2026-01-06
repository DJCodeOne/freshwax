// src/pages/api/admin/process-refund.ts
// Admin API endpoint to process Stripe refunds

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';
import { refundOrderStock } from '../../../lib/order-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { orderId, amount, reason, refundItems } = body;

    if (!orderId) {
      return new Response(JSON.stringify({ error: 'Order ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get order data
    const order = await getDocument('orders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if order has a payment intent
    const paymentIntentId = order.paymentIntentId;
    if (!paymentIntentId) {
      return new Response(JSON.stringify({ error: 'Order has no payment intent - cannot refund' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if already fully refunded
    if (order.refundStatus === 'full') {
      return new Response(JSON.stringify({ error: 'Order already fully refunded' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
        return new Response(JSON.stringify({
          error: `Refund amount exceeds maximum refundable (£${(maxRefundable / 100).toFixed(2)})`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      isFullRefund = refundAmountPence === maxRefundable && previouslyRefunded === 0;
    }

    if (refundAmountPence <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid refund amount' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
        console.log('[process-refund] Stock restored for full refund');
      } catch (stockErr) {
        console.error('[process-refund] Stock restore error:', stockErr);
      }
    } else if (refundItems && refundItems.length > 0) {
      // Partial refund with specific items
      try {
        const itemsToRefund = order.items.filter((item: any) =>
          refundItems.some((ri: any) => ri.id === item.id || ri.id === item.releaseId)
        );
        if (itemsToRefund.length > 0) {
          await refundOrderStock(orderId, itemsToRefund, order.orderNumber || orderId);
          console.log('[process-refund] Stock restored for refunded items');
        }
      } catch (stockErr) {
        console.error('[process-refund] Partial stock restore error:', stockErr);
      }
    }

    // Send refund confirmation email
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY && order.customer?.email) {
      try {
        await fetch('https://api.resend.com/emails', {
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
        });
        console.log('[process-refund] Refund email sent');
      } catch (emailErr) {
        console.error('[process-refund] Email error:', emailErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      refundId: refund.id,
      amount: refundAmountPounds,
      totalRefunded,
      refundStatus: newRefundStatus,
      isFullRefund
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[process-refund] Error:', error);

    // Handle specific Stripe errors
    if (error.type === 'StripeCardError' || error.type === 'StripeInvalidRequestError') {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Failed to process refund' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
