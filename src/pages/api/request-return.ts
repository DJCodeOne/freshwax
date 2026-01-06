// src/pages/api/request-return.ts
// Customer return request API

import type { APIRoute } from 'astro';
import { getDocument, addDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

// Generate RMA number
function generateRMA(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `RMA-${year}${month}-${random}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`return-request:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { orderNumber, email, items, reason, details, photos } = body;

    // Validate required fields
    if (!orderNumber || !email || !reason) {
      return new Response(JSON.stringify({
        error: 'Order number, email, and reason are required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Find order by order number and verify email
    const orders = await queryCollection('orders', {
      filters: [{ field: 'orderNumber', op: 'EQUAL', value: orderNumber.toUpperCase() }],
      limit: 1
    });

    if (orders.length === 0) {
      return new Response(JSON.stringify({
        error: 'Order not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const order = orders[0];

    // Verify email matches
    if (order.customer?.email?.toLowerCase() !== email.toLowerCase()) {
      return new Response(JSON.stringify({
        error: 'Email does not match order'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if order is eligible for return (within 14 days)
    const orderDate = new Date(order.createdAt);
    const daysSinceOrder = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceOrder > 14) {
      return new Response(JSON.stringify({
        error: 'Return period has expired (14 days from order date)'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if return already exists for this order
    const existingReturns = await queryCollection('returns', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: order.id },
        { field: 'status', op: 'IN', value: ['pending', 'approved', 'received'] }
      ],
      limit: 1
    });

    if (existingReturns.length > 0) {
      return new Response(JSON.stringify({
        error: 'A return request already exists for this order',
        existingRMA: existingReturns[0].rmaNumber
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate items (if specified)
    let returnItems = items;
    if (!returnItems || returnItems.length === 0) {
      // Default to all eligible items
      returnItems = (order.items || []).filter((item: any) =>
        item.type === 'vinyl' || item.type === 'merch'
      ).map((item: any) => ({
        id: item.id || item.releaseId || item.productId,
        name: item.name,
        type: item.type,
        quantity: item.quantity || 1,
        price: item.price
      }));
    }

    if (returnItems.length === 0) {
      return new Response(JSON.stringify({
        error: 'No returnable items in this order'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Generate RMA
    const rmaNumber = generateRMA();

    // Calculate refund amount
    const refundAmount = returnItems.reduce((sum: number, item: any) =>
      sum + (item.price * (item.quantity || 1)), 0
    );

    // Create return request
    const returnRequest = await addDocument('returns', {
      rmaNumber,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customer?.userId || null,
      customerEmail: order.customer?.email,
      customerName: `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
      items: returnItems,
      reason,
      details: details || null,
      photos: photos || [],
      refundAmount,
      status: 'pending', // pending -> approved -> received -> refunded | rejected
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    // Update order with return reference
    await updateDocument('orders', order.id, {
      hasReturnRequest: true,
      returnRMA: rmaNumber,
      updatedAt: new Date().toISOString()
    });

    // Send confirmation email
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <returns@freshwax.co.uk>',
            to: [order.customer.email],
            subject: `Return Request Received - ${rmaNumber}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0a0a0a; padding: 40px; color: #fff;">
                <h1 style="color: #3b82f6;">Return Request Received</h1>
                <p>Hi ${order.customer.firstName || 'there'},</p>
                <p>We've received your return request for order <strong>${order.orderNumber}</strong>.</p>

                <div style="background-color: #1f1f1f; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <p style="margin: 0 0 10px;"><strong>RMA Number:</strong> ${rmaNumber}</p>
                  <p style="margin: 0 0 10px;"><strong>Reason:</strong> ${reason}</p>
                  <p style="margin: 0;"><strong>Estimated Refund:</strong> £${refundAmount.toFixed(2)}</p>
                </div>

                <h3 style="color: #fff;">What Happens Next?</h3>
                <ol style="color: #a3a3a3; line-height: 1.8;">
                  <li>We'll review your request within 1-2 business days</li>
                  <li>If approved, we'll send you return shipping instructions</li>
                  <li>Once we receive and inspect the items, your refund will be processed</li>
                </ol>

                <p style="color: #737373; font-size: 13px; margin-top: 30px;">
                  You can track your return status at <a href="https://freshwax.co.uk/account/returns" style="color: #3b82f6;">freshwax.co.uk/account/returns</a>
                </p>

                <p style="color: #737373; font-size: 12px; margin-top: 20px;">Fresh Wax - Underground Music</p>
              </div>
            `
          })
        });
      } catch (emailErr) {
        console.error('[request-return] Email error:', emailErr);
      }
    }

    // Notify admins
    const ADMIN_EMAILS = (env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS || '').split(',').filter(Boolean);
    if (RESEND_API_KEY && ADMIN_EMAILS.length > 0) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <alerts@freshwax.co.uk>',
            to: ADMIN_EMAILS,
            subject: `New Return Request - ${rmaNumber}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px;">
                <h2>New Return Request</h2>
                <p><strong>RMA:</strong> ${rmaNumber}</p>
                <p><strong>Order:</strong> ${order.orderNumber}</p>
                <p><strong>Customer:</strong> ${order.customer.email}</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <p><strong>Amount:</strong> £${refundAmount.toFixed(2)}</p>
                ${details ? `<p><strong>Details:</strong> ${details}</p>` : ''}
                <p><a href="https://freshwax.co.uk/admin/returns">Review in Admin</a></p>
              </div>
            `
          })
        });
      } catch (err) {
        console.error('[request-return] Admin notification error:', err);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      rmaNumber,
      message: 'Return request submitted successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[request-return] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to submit return request'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET endpoint to check return status
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const rmaNumber = url.searchParams.get('rma');
  const email = url.searchParams.get('email');

  if (!rmaNumber || !email) {
    return new Response(JSON.stringify({
      error: 'RMA number and email required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const returns = await queryCollection('returns', {
      filters: [{ field: 'rmaNumber', op: 'EQUAL', value: rmaNumber.toUpperCase() }],
      limit: 1
    });

    if (returns.length === 0) {
      return new Response(JSON.stringify({
        error: 'Return not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const returnRequest = returns[0];

    // Verify email
    if (returnRequest.customerEmail?.toLowerCase() !== email.toLowerCase()) {
      return new Response(JSON.stringify({
        error: 'Email does not match'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      rmaNumber: returnRequest.rmaNumber,
      orderNumber: returnRequest.orderNumber,
      status: returnRequest.status,
      reason: returnRequest.reason,
      items: returnRequest.items,
      refundAmount: returnRequest.refundAmount,
      createdAt: returnRequest.createdAt,
      updatedAt: returnRequest.updatedAt,
      adminNotes: returnRequest.status === 'rejected' ? returnRequest.rejectionReason : null
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[request-return] GET error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to check return status'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
