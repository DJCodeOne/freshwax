// src/pages/api/admin/test-order-email.ts
// Send test confirmation email and check order data
// Usage: GET /api/admin/test-order-email/?orderNumber=FW-260126-1O1JTG&email=test@example.com

import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../../lib/firebase-rest';
import { sendOrderConfirmationEmail } from '../../../lib/order-utils';
import { saQueryCollection, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { getSaQuery } from '../../../lib/admin-query';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('admin/test-order-email');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`test-order-email:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const testEmail = url.searchParams.get('email');
  const sendEmail = url.searchParams.get('send') === 'yes';

  if (!orderNumber) {
    return ApiErrors.badRequest('Missing orderNumber');
  }

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  const saQuery = getSaQuery(locals);
  const serviceAccountKey = getServiceAccountKey(env);

  try {
    // Find order by order number
    const orders = await saQuery('orders', {
      filters: [{ field: 'orderNumber', op: 'EQUAL', value: orderNumber }],
      limit: 1
    });

    if (orders.length === 0) {
      return ApiErrors.notFound('Order not found');
    }

    const order = orders[0];
    const orderId = order.id;

    // Get related data
    const results: Record<string, unknown> = {
      order: {
        id: orderId,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        total: order.total,
        customer: order.customer,
        items: order.items,
        createdAt: order.createdAt,
        paymentMethod: order.paymentMethod
      }
    };

    // Check sales ledger
    if (serviceAccountKey) {
      try {
        const ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
          filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
          limit: 1
        });
        results.salesLedger = ledgerEntries.length > 0 ? ledgerEntries[0] : null;
      } catch (e: unknown) {
        results.salesLedger = { error: 'Could not query' };
      }

      // Check pending payouts
      try {
        const payouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
          filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
          limit: 5
        });
        results.pendingPayouts = payouts;
      } catch (e: unknown) {
        results.pendingPayouts = { error: 'Could not query' };
      }
    }

    // Get release info for items
    const releaseInfo: Record<string, unknown>[] = [];
    for (const item of order.items || []) {
      const releaseId = item.releaseId || item.productId || item.id;
      if (releaseId) {
        try {
          const release = await getDocument('releases', releaseId);
          if (release) {
            releaseInfo.push({
              id: releaseId,
              title: release.title,
              artist: release.artistName || release.artist,
              submitterId: release.submitterId,
              userId: release.userId,
              email: release.email,
              artistEmail: release.artistEmail
            });
          }
        } catch (e: unknown) {
          releaseInfo.push({ id: releaseId, error: 'Could not fetch' });
        }
      }
    }
    results.releases = releaseInfo;

    // Send test email if requested
    if (sendEmail && testEmail) {
      // Create modified order with test email
      const testOrder = {
        ...order,
        customer: {
          ...order.customer,
          email: testEmail
        }
      };

      try {
        await sendOrderConfirmationEmail(testOrder, orderId, order.orderNumber, env);
        results.emailSent = {
          success: true,
          sentTo: testEmail
        };
      } catch (e: unknown) {
        results.emailSent = {
          success: false,
          error: e instanceof Error ? e.message : 'Unknown error'
        };
      }
    } else if (testEmail) {
      results.emailSent = {
        message: 'Add &send=yes to actually send the email',
        wouldSendTo: testEmail
      };
    }

    return jsonResponse(results);

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
