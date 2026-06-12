// src/pages/api/vinyl/orders.ts
// Vinyl seller orders API - fetches orders for a seller
// Uses Firebase REST API with service account

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { saQueryCollection, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { createLogger, ApiErrors, successResponse, escapeHtml } from '../../../lib/api-utils';
import { brandedEmail } from '../../../lib/email-templates/branded';
import { sendResendEmail } from '../../../lib/email';

const log = createLogger('[vinyl-orders]');

const vinylOrderPostSchema = z.object({
  action: z.enum(['mark-shipped', 'add-tracking']),
  orderId: z.string().min(1),
  sellerId: z.string().min(1),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
});

export const prerender = false;

// GET - Fetch seller's orders
export const GET: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};

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

    log.info('Found', orders.length, 'orders for seller:', sellerId);

    return successResponse({ orders: orders || [],
      count: orders.length });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to fetch orders');
  }
};

// POST - Update order status (mark as shipped, etc.)
export const POST: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};

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
        const updateData: Record<string, unknown> = {
          status: 'shipped',
          shippedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        if (carrier) updateData.carrier = carrier;
        if (trackingNumber) updateData.trackingNumber = trackingNumber;

        await saUpdateDocument(serviceAccountKey, projectId, 'vinylOrders', orderId, updateData);

        log.info('Marked order as shipped:', orderId);

        // Notify the buyer their record is on the way (non-blocking)
        try {
          const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
          const buyerEmail = order.buyer?.email;
          if (RESEND_API_KEY && buyerEmail) {
            const itemName = `${order.artist || ''} - ${order.title || 'your record'}`.replace(/^ - /, '');
            const trackingHtml = trackingNumber
              ? `<p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0 0 8px;">Tracking${carrier ? ` (${escapeHtml(carrier)})` : ''}: <strong style="color:#fff;">${escapeHtml(trackingNumber)}</strong></p>`
              : '';
            const html = brandedEmail({
              stripHeadline: '📦 Your vinyl has shipped!',
              stripSubtitle: `Order ${order.orderNumber || ''}`,
              body:
                `<p style="color:#d1d5db;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(order.buyer?.firstName || 'there')},</p>` +
                `<p style="color:#d1d5db;font-size:15px;line-height:1.6;margin:0 0 16px;"><strong style="color:#fff;">${escapeHtml(itemName)}</strong> has been dispatched by ${escapeHtml(order.sellerName || 'the seller')} and is on its way to you.</p>` +
                trackingHtml +
                `<p style="color:#9ca3af;font-size:13px;line-height:1.6;margin:16px 0 0;">Any questions about delivery? Reply to this email and we'll help out.</p>`
            });
            await sendResendEmail({
              apiKey: RESEND_API_KEY,
              from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
              to: [buyerEmail],
              bcc: ['freshwaxonline@gmail.com'],
              subject: `Your vinyl has shipped! ${order.orderNumber ? '- ' + order.orderNumber : ''}`.trim(),
              html,
              template: 'crate-order-shipped',
              db: env?.DB,
            });
            log.info('Buyer shipped-notification sent to:', buyerEmail);
          }
        } catch (emailErr: unknown) {
          log.error('Buyer shipped-notification failed (non-blocking):', emailErr);
        }

        return successResponse({ message: 'Order marked as shipped' });
      }

      case 'add-tracking': {
        const updateData: Record<string, unknown> = {
          updatedAt: new Date().toISOString()
        };

        if (carrier) updateData.carrier = carrier;
        if (trackingNumber) updateData.trackingNumber = trackingNumber;

        await saUpdateDocument(serviceAccountKey, projectId, 'vinylOrders', orderId, updateData);

        return successResponse({ message: 'Tracking info updated' });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
