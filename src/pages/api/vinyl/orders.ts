// src/pages/api/vinyl/orders.ts
// Vinyl seller orders API - fetches orders for a seller
// Uses Firebase REST API with service account

import type { APIRoute } from 'astro';
import { initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

export const prerender = false;

// Get service account key from environment
function getServiceAccountKey(env: any): string | null {
  let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY ||
                          import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountKey) {
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (clientEmail && privateKey) {
      serviceAccountKey = JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        private_key_id: 'auto',
        private_key: privateKey.replace(/\\n/g, '\n'),
        client_email: clientEmail,
        client_id: 'auto',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
      });
    }
  }

  return serviceAccountKey || null;
}

// Initialize Firebase from env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - Fetch seller's orders
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};

  const url = new URL(request.url);
  const sellerId = url.searchParams.get('sellerId');

  if (!sellerId) {
    return new Response(JSON.stringify({ success: false, error: 'Seller ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-orders-read:${clientId}`, {
    maxRequests: 60,
    windowMs: 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Query vinylOrders collection for this seller
    const orders = await saQueryCollection(serviceAccountKey, projectId, 'vinylOrders', {
      filters: [
        { field: 'sellerId', op: 'EQUAL', value: sellerId }
      ],
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit: 100
    });

    console.log('[vinyl/orders GET] Found', orders.length, 'orders for seller:', sellerId);

    return new Response(JSON.stringify({
      success: true,
      orders: orders || [],
      count: orders.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/orders GET] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch orders' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Update order status (mark as shipped, etc.)
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};

  // Rate limit writes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-orders-write:${clientId}`, {
    maxRequests: 30,
    windowMs: 60 * 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { action, orderId, sellerId, carrier, trackingNumber } = body;

    if (!orderId || !sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'Order ID and Seller ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify user owns this order (is the seller)
    if (verifiedUserId !== sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'You can only update your own orders' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Import the update function
    const { saUpdateDocument, saGetDocument } = await import('../../../lib/firebase-service-account');

    // Get the order first to verify ownership
    const order = await saGetDocument(serviceAccountKey, projectId, 'vinylOrders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ success: false, error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (order.sellerId !== sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'Not authorized to update this order' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (action) {
      case 'mark-shipped': {
        const updateData: any = {
          status: 'shipped',
          shippedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        if (carrier) updateData.carrier = carrier;
        if (trackingNumber) updateData.trackingNumber = trackingNumber;

        await saUpdateDocument(serviceAccountKey, projectId, 'vinylOrders', orderId, updateData);

        console.log('[vinyl/orders POST] Marked order as shipped:', orderId);

        return new Response(JSON.stringify({ success: true, message: 'Order marked as shipped' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'add-tracking': {
        const updateData: any = {
          updatedAt: new Date().toISOString()
        };

        if (carrier) updateData.carrier = carrier;
        if (trackingNumber) updateData.trackingNumber = trackingNumber;

        await saUpdateDocument(serviceAccountKey, projectId, 'vinylOrders', orderId, updateData);

        return new Response(JSON.stringify({ success: true, message: 'Tracking info updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      default:
        return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
    }

  } catch (error) {
    console.error('[vinyl/orders POST] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
