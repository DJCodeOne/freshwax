// /src/pages/api/admin/update-order-status.ts
// API endpoint to update order status with optional tracking info

import type { APIRoute } from 'astro';
import { updateDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';
import { refundOrderStock } from '../../../lib/order-utils';

// Valid status transitions
const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { orderId, status, tracking } = body;

    if (!orderId || !status) {
      return new Response(JSON.stringify({ error: 'Order ID and status required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!validStatuses.includes(status)) {
      return new Response(JSON.stringify({ error: 'Invalid status' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

          await fetch('https://api.resend.com/emails', {
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
          });
          console.log('[update-order-status] Shipping notification sent');
        } else if (status === 'cancelled') {
          await fetch('https://api.resend.com/emails', {
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
          });
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