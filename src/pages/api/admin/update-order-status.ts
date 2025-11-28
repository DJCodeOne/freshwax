// /src/pages/api/admin/update-order-status.ts
// API endpoint to update order status with optional tracking info

import type { APIRoute } from 'astro';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Valid status transitions
const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

export const POST: APIRoute = async ({ request }) => {
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
    
    // Build update object based on status
    const updateData: any = {
      status,
      updatedAt: FieldValue.serverTimestamp()
    };
    
    // Add timestamp for specific statuses
    if (status === 'processing') {
      updateData.processingAt = FieldValue.serverTimestamp();
    } else if (status === 'shipped') {
      updateData.shippedAt = FieldValue.serverTimestamp();
      
      // Add tracking info if provided
      if (tracking) {
        updateData.tracking = {
          courier: tracking.courier || null,
          trackingNumber: tracking.trackingNumber || null,
          trackingUrl: tracking.trackingUrl || null,
          addedAt: new Date().toISOString()
        };
      }
    } else if (status === 'delivered') {
      updateData.deliveredAt = FieldValue.serverTimestamp();
    } else if (status === 'cancelled') {
      updateData.cancelledAt = FieldValue.serverTimestamp();
    }
    
    // Update order document
    await db.collection('orders').doc(orderId).update(updateData);
    
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