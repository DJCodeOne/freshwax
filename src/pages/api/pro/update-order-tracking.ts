// /src/pages/api/pro/update-order-tracking.ts
// Artist self-service endpoint: lets the artist mark one of their orders as
// shipped and attach tracking info. Strictly scoped — the order must contain
// at least one physical item whose artistId matches the authenticated user,
// otherwise we refuse. Only the tracking + shipped status fields are mutable
// here; admins still own cancellation / refund / arbitrary status changes via
// /api/admin/update-order-status.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseJsonBody, fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('[pro/update-order-tracking]');

export const prerender = false;

const schema = z.object({
  orderId: z.string().min(1),
  status: z.enum(['shipped', 'delivered']).default('shipped'),
  tracking: z.object({
    courier: z.string().min(1).max(100),
    trackingNumber: z.string().min(1).max(200),
    trackingUrl: z.string().url().optional(),
  }),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`pro-update-tracking:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) return ApiErrors.unauthorized(authError || 'Authentication required');

  const body = await parseJsonBody(request);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request: ' + parsed.error.issues.map(i => i.message).join(', '));
  }
  const { orderId, status, tracking } = parsed.data;

  const orderData = await getDocument('orders', orderId);
  if (!orderData) return ApiErrors.notFound('Order not found');

  // Authorisation: the calling user must own at least one physical item in the order.
  // This is the artist-scope check — admins use the unrestricted /api/admin endpoint.
  const items = (orderData.items as Record<string, unknown>[]) || [];
  const hasOwnedPhysicalItem = items.some(it => {
    const isMine = it.artistId === userId;
    const isPhysical = it.type === 'vinyl' || it.format === 'vinyl' || it.type === 'merch';
    return isMine && isPhysical;
  });
  if (!hasOwnedPhysicalItem) {
    log.warn(`User ${userId} tried to update tracking on order ${orderId} they don't own`);
    return ApiErrors.forbidden('You do not have permission to update this order');
  }

  if (orderData.paymentStatus !== 'completed') {
    return ApiErrors.badRequest('Cannot mark an unpaid order as shipped');
  }
  if (orderData.status === 'cancelled' || orderData.status === 'refunded') {
    return ApiErrors.badRequest(`Cannot ship a ${orderData.status} order`);
  }

  const now = new Date().toISOString();
  const updateData: Record<string, unknown> = {
    status,
    updatedAt: now,
    tracking: {
      courier: tracking.courier,
      trackingNumber: tracking.trackingNumber,
      trackingUrl: tracking.trackingUrl || null,
      addedAt: now,
      addedBy: userId,
    },
  };
  if (status === 'shipped') updateData.shippedAt = now;
  if (status === 'delivered') updateData.deliveredAt = now;

  await updateDocument('orders', orderId, updateData);
  log.info(`Order ${orderId} marked ${status} by artist ${userId}`);

  // Notify the customer — same template shape as the admin endpoint
  const env = locals.runtime.env as Record<string, unknown> | undefined;
  const RESEND_API_KEY = (env?.RESEND_API_KEY as string) || import.meta.env.RESEND_API_KEY;
  const customer = (orderData.customer as Record<string, unknown> | undefined) || {};
  const customerEmail = customer.email as string | undefined;
  if (RESEND_API_KEY && customerEmail && status === 'shipped') {
    const trackingHtml = tracking.trackingNumber
      ? `<p><strong>Tracking Number:</strong> ${tracking.trackingNumber}</p>
         ${tracking.trackingUrl ? `<p><a href="${tracking.trackingUrl}" style="color: #dc2626;">Track Your Package</a></p>` : ''}`
      : '';
    try {
      const resp = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Fresh Wax <orders@freshwax.co.uk>',
          to: [customerEmail],
          subject: `Your order ${orderData.orderNumber || orderId} has been shipped!`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h1 style="color: #dc2626;">Your Order Has Shipped!</h1>
              <p>Hi ${customer.firstName || 'there'},</p>
              <p>Great news! Your order <strong>${orderData.orderNumber || orderId}</strong> is on its way.</p>
              ${trackingHtml}
              <p>Thank you for shopping with Fresh Wax!</p>
              <p style="color: #666; font-size: 12px;">Fresh Wax - Underground Music</p>
            </div>
          `,
        }),
      }, 10000);
      if (!resp.ok) log.error('Shipping email failed', { status: resp.status });
    } catch (e) {
      log.error('Shipping email error', e);
    }
  }

  return successResponse({ orderId, status, tracking: updateData.tracking });
};
