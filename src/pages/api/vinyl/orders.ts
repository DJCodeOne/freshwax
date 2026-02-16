// src/pages/api/vinyl/orders.ts
// Vinyl seller orders API - fetches orders for a seller
// Uses Firebase REST API with service account

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

const vinylOrderPostSchema = z.object({
  action: z.enum(['mark-shipped', 'add-tracking']),
  orderId: z.string().min(1),
  sellerId: z.string().min(1),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
});

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

function initFirebase(locals: App.Locals) {
  const env = locals?.runtime?.env || {};
}

// GET - Fetch seller's orders
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = locals.runtime.env || {};

  const url = new URL(request.url);
  const sellerId = url.searchParams.get('sellerId');

  if (!sellerId) {
    return ApiErrors.badRequest('Seller ID required');
  }

  // SECURITY: Verify authentication and that user is the seller
  const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
  if (authError || !verifiedUserId) {
    return ApiErrors.unauthorized('Authentication required');
  }

  if (verifiedUserId !== sellerId) {
    return ApiErrors.forbidden('You can only view your own orders');
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
      return ApiErrors.serverError('Service account not configured');
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
    return ApiErrors.serverError('Failed to fetch orders');
  }
};

// POST - Update order status (mark as shipped, etc.)
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = locals.runtime.env || {};

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
      return ApiErrors.unauthorized('Authentication required');
    }

    const body = await request.json();

    const parsed = vinylOrderPostSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, orderId, sellerId, carrier, trackingNumber } = parsed.data;

    // Verify user owns this order (is the seller)
    if (verifiedUserId !== sellerId) {
      return ApiErrors.forbidden('You can only update your own orders');
    }

    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    // Import the update function
    const { saUpdateDocument, saGetDocument } = await import('../../../lib/firebase-service-account');

    // Get the order first to verify ownership
    const order = await saGetDocument(serviceAccountKey, projectId, 'vinylOrders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    if (order.sellerId !== sellerId) {
      return ApiErrors.forbidden('Not authorized to update this order');
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
        return ApiErrors.badRequest('Invalid action');
    }

  } catch (error) {
    console.error('[vinyl/orders POST] Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
