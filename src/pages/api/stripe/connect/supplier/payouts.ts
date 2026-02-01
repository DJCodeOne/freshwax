// src/pages/api/stripe/connect/supplier/payouts.ts
// Get payout history for a supplier

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const supplierId = url.searchParams.get('supplierId');
  const accessCode = url.searchParams.get('code');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  if (!supplierId && !accessCode) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Supplier ID or access code required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // Get supplier
    let supplier: any = null;
    let supplierDocId = supplierId;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
    } else if (accessCode) {
      const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const found = suppliers.find((s: any) => s.accessCode === accessCode);
      if (found) {
        supplier = found;
        supplierDocId = found.id;
      }
    }

    if (!supplier) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
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

    return new Response(JSON.stringify({
      success: true,
      payouts: payouts.map((p: any) => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        amount: p.amount,
        status: p.status,
        productName: p.productName,
        createdAt: p.createdAt,
        completedAt: p.completedAt
      })),
      pendingPayouts: pendingPayouts.map((p: any) => ({
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
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] Supplier payouts error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get payouts'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
