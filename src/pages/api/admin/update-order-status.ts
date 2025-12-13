// /src/pages/api/admin/update-order-status.ts
// API endpoint to update order status with optional tracking info

import type { APIRoute } from 'astro';
import { updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

// Valid status transitions
const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { orderId, status, tracking } = await request.json();

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

    // Update order document
    await updateDocument('orders', orderId, updateData);

    // TODO: Send email notifications for status changes
    // e.g., "Your order has been shipped!" with tracking info
    // if (status === 'shipped' && tracking?.trackingNumber) {
    //   await sendShippingEmail(order.email, tracking);
    // }

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