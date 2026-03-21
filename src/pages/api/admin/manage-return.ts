// src/pages/api/admin/manage-return.ts
// Admin API for managing return requests

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody, fetchWithTimeout, ApiErrors, createLogger, successResponse, jsonResponse } from '../../../lib/api-utils';
import { formatPrice } from '../../../lib/format-utils';

const log = createLogger('admin/manage-return');
import { refundOrderStock } from '../../../lib/order-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const manageReturnPostSchema = z.object({
  returnId: z.string().min(1),
  action: z.enum(['approve', 'reject', 'received', 'refund']),
  notes: z.string().optional(),
  refundAmount: z.number().positive().optional(),
  adminKey: z.string().optional(),
});

export const prerender = false;

// HTML-escape user-derived strings to prevent injection in emails
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`manage-return:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = locals.runtime.env;


  try {
    const parsed = manageReturnPostSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { returnId, action, notes, refundAmount } = parsed.data;

    const returnRequest = await getDocument('returns', returnId);
    if (!returnRequest) {
      return ApiErrors.notFound('Return not found');
    }

    const now = new Date().toISOString();
    let updateData: Record<string, unknown> = { updatedAt: now };
    let emailSubject = '';
    let emailContent = '';

    switch (action) {
      case 'approve':
        updateData.status = 'approved';
        updateData.approvedAt = now;
        updateData.adminNotes = notes || null;
        emailSubject = `Return Approved - ${esc(returnRequest.rmaNumber)}`;
        emailContent = `
          <p>Great news! Your return request has been approved.</p>
          <h3>Return Instructions:</h3>
          <ol>
            <li>Pack items securely in original packaging if possible</li>
            <li>Include a note with your RMA number: <strong>${esc(returnRequest.rmaNumber)}</strong></li>
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
        emailSubject = `Return Request Update - ${esc(returnRequest.rmaNumber)}`;
        emailContent = `
          <p>Unfortunately, we are unable to approve your return request at this time.</p>
          <p><strong>Reason:</strong> ${esc(updateData.rejectionReason)}</p>
          <p>If you believe this is an error or have questions, please contact us at contact@freshwax.co.uk</p>
        `;
        break;

      case 'received':
        updateData.status = 'received';
        updateData.receivedAt = now;
        updateData.adminNotes = notes || null;
        emailSubject = `Items Received - ${esc(returnRequest.rmaNumber)}`;
        emailContent = `
          <p>We've received your returned items and are inspecting them now.</p>
          <p>Your refund will be processed within 3-5 business days once inspection is complete.</p>
        `;
        break;

      case 'refund':
        // Process refund via Stripe
        const order = await getDocument('orders', returnRequest.orderId);
        if (!order?.paymentIntentId) {
          return ApiErrors.badRequest('Cannot refund - no payment intent found');
        }

        const finalRefundAmount = refundAmount || returnRequest.refundAmount;

        // Call the process-refund endpoint
        const origin = new URL(request.url).origin;
        const refundResponse = await fetchWithTimeout(`${origin}/api/admin/process-refund/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: returnRequest.orderId,
            amount: finalRefundAmount,
            reason: 'requested_by_customer',
            refundItems: returnRequest.items,
            adminKey: body.adminKey
          })
        }, 10000);

        if (!refundResponse.ok) {
          const refundError = await refundResponse.json().catch(() => ({ error: 'Refund failed' }));
          return ApiErrors.badRequest(refundError.error || 'Refund failed');
        }

        const refundResult = await refundResponse.json();

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
          } catch (stockErr: unknown) {
            log.error('Stock restore error:', stockErr);
          }
        }

        emailSubject = `Refund Processed - ${esc(returnRequest.rmaNumber)}`;
        emailContent = `
          <p>Your refund has been processed!</p>
          <div style="background-color: #1f1f1f; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Refund Amount:</strong> ${formatPrice(finalRefundAmount)}</p>
          </div>
          <p>The funds will appear in your account within 5-10 business days depending on your bank.</p>
          <p>Thank you for your patience!</p>
        `;
        break;

      default:
        return ApiErrors.badRequest('Invalid action');
    }

    // Update return request
    await updateDocument('returns', returnId, updateData);

    // Send email notification
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY && returnRequest.customerEmail && emailSubject) {
      try {
        const returnEmailResp = await fetchWithTimeout('https://api.resend.com/emails', {
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
                <h1 style="color: #3b82f6;">${esc(emailSubject.split(' - ')[0])}</h1>
                <p>Hi ${esc(returnRequest.customerName || 'there')},</p>
                <p>Update for return request <strong>${esc(returnRequest.rmaNumber)}</strong>:</p>
                ${emailContent}
                <p style="color: #737373; font-size: 12px; margin-top: 30px;">Fresh Wax - Underground Music</p>
              </div>
            `
          })
        }, 10000);
        if (!returnEmailResp.ok) {
          log.error('Return email failed', { status: returnEmailResp.status });
        }
      } catch (emailErr: unknown) {
        log.error('Email error:', emailErr);
      }
    }

    return successResponse({ status: updateData.status });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update return');
  }
};

// GET endpoint to list returns (admin only)
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`manage-return-list:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);



  try {
    const filters: Record<string, unknown>[] = [];
    if (status && status !== 'all') {
      filters.push({ field: 'status', op: 'EQUAL', value: status });
    }

    const returns = await queryCollection('returns', {
      filters,
      orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
      limit
    });

    // Get counts by status using parallel filtered queries
    const [pendingReturns, approvedReturns, receivedReturns, refundedReturns, rejectedReturns] = await Promise.all([
      queryCollection('returns', { filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }], limit: 500 }),
      queryCollection('returns', { filters: [{ field: 'status', op: 'EQUAL', value: 'approved' }], limit: 500 }),
      queryCollection('returns', { filters: [{ field: 'status', op: 'EQUAL', value: 'received' }], limit: 500 }),
      queryCollection('returns', { filters: [{ field: 'status', op: 'EQUAL', value: 'refunded' }], limit: 500 }),
      queryCollection('returns', { filters: [{ field: 'status', op: 'EQUAL', value: 'rejected' }], limit: 500 }),
    ]);
    const counts = {
      pending: pendingReturns.length,
      approved: approvedReturns.length,
      received: receivedReturns.length,
      refunded: refundedReturns.length,
      rejected: rejectedReturns.length
    };

    return jsonResponse({
      returns,
      counts
    });

  } catch (error: unknown) {
    log.error('GET error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to fetch returns');
  }
};
