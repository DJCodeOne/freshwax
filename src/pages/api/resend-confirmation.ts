// src/pages/api/resend-confirmation.ts
// Resend order confirmation email (admin only)

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { sendOrderConfirmationEmail, getShortOrderNumber } from '../../lib/order-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;

    const body = await request.json();
    const { orderId, key } = body;

    // Simple admin check
    if (key !== adminKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!orderId) {
      return new Response(JSON.stringify({ error: 'Missing orderId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Initialize Firebase
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Get order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[resend-confirmation] Sending email for order:', order.orderNumber);
    console.log('[resend-confirmation] Customer:', order.customer?.email);
    console.log('[resend-confirmation] RESEND_API_KEY exists:', !!env?.RESEND_API_KEY);

    // Send email
    await sendOrderConfirmationEmail(order, orderId, order.orderNumber, env);

    return new Response(JSON.stringify({
      success: true,
      message: 'Confirmation email sent',
      orderNumber: order.orderNumber,
      email: order.customer?.email
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[resend-confirmation] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
