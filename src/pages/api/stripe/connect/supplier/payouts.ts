// src/pages/api/stripe/connect/supplier/payouts.ts
// Get payout history for a supplier

import type { APIRoute } from 'astro';
import { getDocument, queryCollection } from '@lib/firebase-rest';
import { ApiErrors, createLogger, successResponse } from '@lib/api-utils';

const log = createLogger('stripe/connect/supplier/payouts');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-supplier-payouts:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const supplierId = url.searchParams.get('supplierId');
  const accessCode = url.searchParams.get('code');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  // SECURITY: Always require access code — supplierId alone is not authentication
  if (!accessCode) {
    return ApiErrors.unauthorized('Access code required');
  }

  const env = locals.runtime.env;


  try {
    // Get supplier — always verify access code
    let supplier: Record<string, unknown> | null = null;
    let supplierDocId = supplierId;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
      // SECURITY: Verify access code matches
      if (supplier && supplier.accessCode !== accessCode) {
        return ApiErrors.forbidden('Invalid access code');
      }
    } else {
      // Look up by access code
      const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const found = suppliers.find((s: Record<string, unknown>) => s.accessCode === accessCode);
      if (found) {
        supplier = found;
        supplierDocId = found.id;
      }
    }

    if (!supplier) {
      return ApiErrors.notFound('Supplier not found');
    }

    // Get payouts
    const payouts = await queryCollection('supplierPayouts', {
      filters: [{ field: 'supplierId', op: 'EQUAL', value: supplierDocId }],
      orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
      limit
    });

    // Calculate totals
    let totalPaid = 0;
    let totalPending = 0;
    let thisMonthPaid = 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    for (const payout of payouts) {
      if (payout.status === 'completed') {
        totalPaid += payout.amount || 0;
        if (payout.completedAt >= monthStart) {
          thisMonthPaid += payout.amount || 0;
        }
      } else if (payout.status === 'pending') {
        totalPending += payout.amount || 0;
      }
    }

    // Get pending payouts (for suppliers not yet connected)
    const pendingPayouts = await queryCollection('pendingSupplierPayouts', {
      filters: [{ field: 'supplierId', op: 'EQUAL', value: supplierDocId }],
      limit: 50
    });

    for (const pending of pendingPayouts) {
      totalPending += pending.amount || 0;
    }

    return successResponse({ payouts: payouts.map((p: Record<string, unknown>) => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        amount: p.amount,
        status: p.status,
        productName: p.productName,
        createdAt: p.createdAt,
        completedAt: p.completedAt
      })),
      pendingPayouts: pendingPayouts.map((p: Record<string, unknown>) => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        amount: p.amount,
        productName: p.productName,
        createdAt: p.createdAt
      })),
      summary: {
        totalPaid,
        totalPending,
        thisMonthPaid,
        payoutCount: payouts.length
      } });

  } catch (error: unknown) {
    log.error('[Stripe Connect] Supplier payouts error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get payouts');
  }
};
