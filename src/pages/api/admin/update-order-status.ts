// /src/pages/api/admin/update-order-status.ts
// API endpoint to update order status with optional tracking info

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, getDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, fetchWithTimeout } from '../../../lib/api-utils';
import { refundOrderStock } from '../../../lib/order-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

// Valid status transitions
const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] as const;

const updateOrderStatusSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(validStatuses),
  tracking: z.object({
    courier: z.string().optional(),
    trackingNumber: z.string().optional(),
    trackingUrl: z.string().url().optional(),
  }).optional(),
  adminKey: z.string().optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-order-status:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    const parsed = updateOrderStatusSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { orderId, status, tracking } = parsed.data;

    const now = new Date().toISOString();

    // Build update object based on status
    const updateData: any = {
      status,
      updatedAt: now
    };

    // Add timestamp for specific statuses
    if (status === 'processing') {
      updateData.processingAt = now;
    } else if (status === 'shipped') {
      updateData.shippedAt = now;

      // Add tracking info if provided
      if (tracking) {
        updateData.tracking = {
          courier: tracking.courier || null,
          trackingNumber: tracking.trackingNumber || null,
          trackingUrl: tracking.trackingUrl || null,
          addedAt: now
        };
      }
    } else if (status === 'delivered') {
      updateData.deliveredAt = now;
    } else if (status === 'cancelled') {
      updateData.cancelledAt = now;
    }

    // Get order data for cancellation refund and email notifications
    const orderData = await getDocument('orders', orderId);

    // Update order document
    await updateDocument('orders', orderId, updateData);

    // Refund stock if order is cancelled
    if (status === 'cancelled' && orderData?.items) {
      console.log('[update-order-status] Refunding stock for cancelled order:', orderId);
      try {
        await refundOrderStock(orderId, orderData.items, orderData.orderNumber || orderId);
        console.log('[update-order-status] Stock refunded successfully');
      } catch (refundErr) {
        console.error('[update-order-status] Stock refund error:', refundErr);
        // Continue - order is still cancelled even if refund fails
      }
    }

    // Send email notifications for status changes
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY && orderData?.customer?.email) {
      try {
        if (status === 'shipped') {
          const trackingInfo = tracking?.trackingNumber
            ? `<p><strong>Tracking Number:</strong> ${tracking.trackingNumber}</p>
               ${tracking.trackingUrl ? `<p><a href="${tracking.trackingUrl}" style="color: #dc2626;">Track Your Package</a></p>` : ''}`
            : '';

          await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax <orders@freshwax.co.uk>',
              to: [orderData.customer.email],
              subject: `Your order ${orderData.orderNumber || orderId} has been shipped!`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h1 style="color: #dc2626;">Your Order Has Shipped!</h1>
                  <p>Hi ${orderData.customer.firstName || 'there'},</p>
                  <p>Great news! Your order <strong>${orderData.orderNumber || orderId}</strong> is on its way.</p>
                  ${trackingInfo}
                  <p>Thank you for shopping with Fresh Wax!</p>
                  <p style="color: #666; font-size: 12px;">Fresh Wax - Underground Music</p>
                </div>
              `
            })
          }, 10000);
          console.log('[update-order-status] Shipping notification sent');
        } else if (status === 'cancelled') {
          await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax <orders@freshwax.co.uk>',
              to: [orderData.customer.email],
              subject: `Your order ${orderData.orderNumber || orderId} has been cancelled`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h1 style="color: #dc2626;">Order Cancelled</h1>
                  <p>Hi ${orderData.customer.firstName || 'there'},</p>
                  <p>Your order <strong>${orderData.orderNumber || orderId}</strong> has been cancelled.</p>
                  <p>If you paid for this order, a refund will be processed within 5-7 business days.</p>
                  <p>If you have any questions, please contact us.</p>
                  <p style="color: #666; font-size: 12px;">Fresh Wax - Underground Music</p>
                </div>
              `
            })
          }, 10000);
          console.log('[update-order-status] Cancellation notification sent');
        }
      } catch (emailErr) {
        console.error('[update-order-status] Email notification error:', emailErr);
        // Continue - status update succeeded even if email fails
      }
    }

    return new Response(JSON.stringify({ success: true, status }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error updating order status:', error);
    return new Response(JSON.stringify({ error: 'Failed to update order status' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};