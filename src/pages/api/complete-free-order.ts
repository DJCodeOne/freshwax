// src/pages/api/complete-free-order.ts
// Handles free orders (total = 0) without payment processing

import type { APIRoute } from 'astro';
import { createOrder } from '../../lib/order-utils';
import { initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  console.log('[complete-free-order] ========== FREE ORDER REQUEST ==========');
  console.log('[complete-free-order] Timestamp:', new Date().toISOString());

  try {
    const env = (locals as any)?.runtime?.env;

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    console.log('[complete-free-order] Firebase projectId:', projectId || 'MISSING');
    console.log('[complete-free-order] Firebase apiKey exists:', !!apiKey);

    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    // Parse request body
    const orderData = await request.json();
    console.log('[complete-free-order] Order data received');
    console.log('[complete-free-order]   - Customer:', orderData.customer?.email);
    console.log('[complete-free-order]   - Items:', orderData.items?.length || 0);
    console.log('[complete-free-order]   - Total:', orderData.totals?.total);

    // Verify this is actually a free order
    if (orderData.totals?.total > 0) {
      console.error('[complete-free-order] ERROR: Order total is not 0');
      return new Response(JSON.stringify({
        success: false,
        error: 'This endpoint is only for free orders (total must be 0)'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate required fields
    if (!orderData.customer?.email || !orderData.customer?.firstName || !orderData.customer?.lastName) {
      console.error('[complete-free-order] ERROR: Missing customer details');
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required customer details'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!orderData.items || orderData.items.length === 0) {
      console.error('[complete-free-order] ERROR: No items in order');
      return new Response(JSON.stringify({
        success: false,
        error: 'Order must contain at least one item'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Set totals to 0 for free orders (no fees)
    const totals = {
      subtotal: 0,
      shipping: 0,
      freshWaxFee: 0,
      stripeFee: 0,
      serviceFees: 0,
      total: 0
    };

    // Create the order using the shared order creation utility
    const result = await createOrder({
      orderData: {
        customer: orderData.customer,
        shipping: orderData.shipping || null,
        items: orderData.items,
        totals,
        hasPhysicalItems: orderData.hasPhysicalItems || false,
        paymentMethod: 'free',
        paymentIntentId: null,
        paypalOrderId: null
      },
      env,
      idToken: orderData.idToken
    });

    if (result.success) {
      console.log('[complete-free-order] ✅ Order created successfully');
      console.log('[complete-free-order]   - Order ID:', result.orderId);
      console.log('[complete-free-order]   - Order Number:', result.orderNumber);

      return new Response(JSON.stringify({
        success: true,
        orderId: result.orderId,
        orderNumber: result.orderNumber
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      console.error('[complete-free-order] ❌ Order creation failed:', result.error);
      return new Response(JSON.stringify({
        success: false,
        error: result.error || 'Failed to create order'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[complete-free-order] ❌ ERROR:', errorMessage);

    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
