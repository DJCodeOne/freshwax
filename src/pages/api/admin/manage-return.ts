// src/pages/api/admin/manage-return.ts
// Admin API for managing return requests

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';
import { refundOrderStock } from '../../../lib/order-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { returnId, action, notes, refundAmount } = body;

    if (!returnId || !action) {
      return new Response(JSON.stringify({
        error: 'Return ID and action required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const returnRequest = await getDocument('returns', returnId);
    if (!returnRequest) {
      return new Response(JSON.stringify({
        error: 'Return not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const now = new Date().toISOString();
    let updateData: any = { updatedAt: now };
    let emailSubject = '';
    let emailContent = '';

    switch (action) {
      case 'approve':
        updateData.status = 'approved';
        updateData.approvedAt = now;
        updateData.adminNotes = notes || null;
        emailSubject = `Return Approved - ${returnRequest.rmaNumber}`;
        emailContent = `
          <p>Great news! Your return request has been approved.</p>
          <h3>Return Instructions:</h3>
          <ol>
            <li>Pack items securely in original packaging if possible</li>
            <li>Include a note with your RMA number: <strong>${returnRequest.rmaNumber}</strong></li>
            <li>Send to:<br>
              <strong>Fresh Wax Returns</strong><br>
              [Your return address here]
            </li>
          </ol>
          <p>Once we receive and inspect your items, your refund will be processed within 5-7 business days.</p>
        `;
        break;

      case 'reject':
        updateData.status = 'rejected';
        updateData.rejectedAt = now;
        updateData.rejectionReason = notes || 'Return request does not meet our return policy requirements';
        emailSubject = `Return Request Update - ${returnRequest.rmaNumber}`;
        emailContent = `
          <p>Unfortunately, we are unable to approve your return request at this time.</p>
          <p><strong>Reason:</strong> ${updateData.rejectionReason}</p>
          <p>If you believe this is an error or have questions, please contact us at contact@freshwax.co.uk</p>
        `;
        break;

      case 'received':
        updateData.status = 'received';
        updateData.receivedAt = now;
        updateData.adminNotes = notes || null;
        emailSubject = `Items Received - ${returnRequest.rmaNumber}`;
        emailContent = `
          <p>We've received your returned items and are inspecting them now.</p>
          <p>Your refund will be processed within 3-5 business days once inspection is complete.</p>
        `;
        break;

      case 'refund':
        // Process refund via Stripe
        const order = await getDocument('orders', returnRequest.orderId);
        if (!order?.paymentIntentId) {
          return new Response(JSON.stringify({
            error: 'Cannot refund - no payment intent found'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const finalRefundAmount = refundAmount || returnRequest.refundAmount;

        // Call the process-refund endpoint
        const origin = new URL(request.url).origin;
        const refundResponse = await fetch(`${origin}/api/admin/process-refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: returnRequest.orderId,
            amount: finalRefundAmount,
            reason: 'requested_by_customer',
            refundItems: returnRequest.items,
            adminKey: body.adminKey
          })
        });

        const refundResult = await refundResponse.json();

        if (!refundResponse.ok) {
          return new Response(JSON.stringify({
            error: refundResult.error || 'Refund failed'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        updateData.status = 'refunded';
        updateData.refundedAt = now;
        updateData.refundId = refundResult.refundId;
        updateData.finalRefundAmount = finalRefundAmount;

        // Restore stock
        if (returnRequest.items?.length > 0) {
          try {
            await refundOrderStock(
              returnRequest.orderId,
              returnRequest.items,
              returnRequest.orderNumber
            );
          } catch (stockErr) {
            console.error('[manage-return] Stock restore error:', stockErr);
          }
        }

        emailSubject = `Refund Processed - ${returnRequest.rmaNumber}`;
        emailContent = `
          <p>Your refund has been processed!</p>
          <div style="background-color: #1f1f1f; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Refund Amount:</strong> £${finalRefundAmount.toFixed(2)}</p>
          </div>
          <p>The funds will appear in your account within 5-10 business days depending on your bank.</p>
          <p>Thank you for your patience!</p>
        `;
        break;

      default:
        return new Response(JSON.stringify({
          error: 'Invalid action'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Update return request
    await updateDocument('returns', returnId, updateData);

    // Send email notification
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY && returnRequest.customerEmail && emailSubject) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <returns@freshwax.co.uk>',
            to: [returnRequest.customerEmail],
            subject: emailSubject,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0a0a0a; padding: 40px; color: #fff;">
                <h1 style="color: #3b82f6;">${emailSubject.split(' - ')[0]}</h1>
                <p>Hi ${returnRequest.customerName || 'there'},</p>
                <p>Update for return request <strong>${returnRequest.rmaNumber}</strong>:</p>
                ${emailContent}
                <p style="color: #737373; font-size: 12px; margin-top: 30px;">Fresh Wax - Underground Music</p>
              </div>
            `
          })
        });
      } catch (emailErr) {
        console.error('[manage-return] Email error:', emailErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      status: updateData.status
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[manage-return] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to update return'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET endpoint to list returns
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const filters: any[] = [];
    if (status && status !== 'all') {
      filters.push({ field: 'status', op: 'EQUAL', value: status });
    }

    const returns = await queryCollection('returns', {
      filters,
      orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
      limit
    });

    // Get counts by status
    const allReturns = await queryCollection('returns', { limit: 500 });
    const counts = {
      pending: 0,
      approved: 0,
      received: 0,
      refunded: 0,
      rejected: 0
    };

    for (const r of allReturns) {
      if (counts.hasOwnProperty(r.status)) {
        counts[r.status as keyof typeof counts]++;
      }
    }

    return new Response(JSON.stringify({
      returns,
      counts
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[manage-return] GET error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to fetch returns'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
