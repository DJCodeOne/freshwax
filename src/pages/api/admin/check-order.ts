// src/pages/api/admin/check-order.ts
// Check order details including fees

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('id') || 'fRh0piRRDvBtXaOYOIdD';

  const runtimeEnv = (locals as any)?.runtime?.env;
  initFirebaseEnv(runtimeEnv);

  try {
    const order = await getDocument('orders', orderId);

    if (!order) {
      return new Response(JSON.stringify({ success: false, error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Calculate what payout should be
    const subtotal = order.totals?.subtotal || 0;
    const freshWaxFee = order.totals?.freshWaxFee || 0;
    const paypalFee = order.paypalFee || order.actualPaypalFee || 0;
    const stripeFee = order.totals?.stripeFee || 0;
    const totalFees = freshWaxFee + paypalFee + stripeFee;
    const artistPayout = Math.round((subtotal - totalFees) * 100) / 100;

    return new Response(JSON.stringify({
      success: true,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        totals: order.totals,
        paypalFee: order.paypalFee,
        actualPaypalFee: order.actualPaypalFee,
        calculatedPayout: {
          subtotal,
          freshWaxFee,
          paypalFee,
          stripeFee,
          totalFees,
          artistPayout
        },
        items: order.items,
        customer: order.customer,
        createdAt: order.createdAt
      }
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
