import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, addDocument } from '@lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '@lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';
import { escapeHtml } from '@lib/escape-html';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '@lib/api-utils';

const log = createLogger('[vinyl-order]');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`vinyl-order:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  // SECURITY: Require admin authentication for viewing order data
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const orderId = url.searchParams.get('id');

  if (!orderId) {
    return ApiErrors.badRequest('Order ID required');
  }

  try {
    const order = await getDocument('vinylOrders', orderId);

    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    return successResponse({ order });
  } catch (error: unknown) {
    log.error('[API vinyl/order] Error:', error);
    return ApiErrors.serverError('Failed to fetch order');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`vinyl-order-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  // SECURITY: Require admin authentication for order management
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const body = await request.json();
    const { action, orderId } = body;

    if (!orderId) {
      return ApiErrors.badRequest('Order ID required');
    }

    const order = await getDocument('vinylOrders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    switch (action) {
      case 'update-status': {
        const { status } = body;
        const validStatuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

        if (!validStatuses.includes(status)) {
          return ApiErrors.badRequest('Invalid status');
        }

        const updateData: Record<string, unknown> = {
          status,
          updatedAt: new Date().toISOString()
        };

        // Add timestamp for status change
        if (status === 'paid') updateData.paidAt = new Date().toISOString();
        if (status === 'shipped') updateData.shippedAt = new Date().toISOString();
        if (status === 'delivered') updateData.deliveredAt = new Date().toISOString();
        if (status === 'cancelled') updateData.cancelledAt = new Date().toISOString();

        await updateDocument('vinylOrders', orderId, updateData);

        return successResponse({ message: 'Order status updated' });
      }

      case 'add-tracking': {
        const { carrier, trackingNumber } = body;

        await updateDocument('vinylOrders', orderId, {
          carrier: carrier || '',
          trackingNumber: trackingNumber || '',
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Tracking info updated' });
      }

      case 'refund': {
        // Prevent double refund
        if (order.status === 'refunded') {
          return ApiErrors.badRequest('Order already refunded');
        }

        // 1. Look up parent order to get paymentIntentId
        const parentOrderId = order.orderId;
        if (!parentOrderId) {
          return ApiErrors.badRequest('Vinyl order has no linked parent order');
        }

        const parentOrder = await getDocument('orders', parentOrderId);
        if (!parentOrder) {
          return ApiErrors.notFound('Parent order not found');
        }

        const paymentIntentId = parentOrder.paymentIntentId;
        if (!paymentIntentId) {
          return ApiErrors.badRequest('Parent order has no payment intent - cannot refund');
        }

        // 2. Initialize Stripe
        const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
        if (!stripeSecretKey) {
          return ApiErrors.serverError('Stripe not configured');
        }

        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

        // 3. Calculate refund amount
        const orderTotal = (order.price || 0) + (order.shippingCost || 0);
        const previouslyRefunded = order.refundedAmount || 0;
        const maxRefundable = Math.round((orderTotal - previouslyRefunded) * 100); // Convert to pence

        let refundAmountPence: number;
        let isFullRefund = false;
        const { refundAmount, reason } = body;

        if (refundAmount === undefined || refundAmount === null || refundAmount === 'full') {
          // Full refund of remaining amount
          refundAmountPence = maxRefundable;
          isFullRefund = previouslyRefunded === 0;
        } else {
          // Partial refund
          refundAmountPence = Math.round(parseFloat(refundAmount) * 100);
          if (refundAmountPence > maxRefundable) {
            return ApiErrors.badRequest('Refund amount exceeds maximum refundable (\u00a3${(maxRefundable / 100).toFixed(2)})');
          }
          isFullRefund = refundAmountPence === maxRefundable && previouslyRefunded === 0;
        }

        if (refundAmountPence <= 0) {
          return ApiErrors.badRequest('Invalid refund amount');
        }

        // 4. Create Stripe refund — do this BEFORE updating any records
        let refund: Stripe.Refund;
        try {
          refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            amount: refundAmountPence,
            reason: reason === 'duplicate' ? 'duplicate' :
                    reason === 'fraudulent' ? 'fraudulent' :
                    'requested_by_customer',
            metadata: {
              vinylOrderId: orderId,
              parentOrderId,
              orderNumber: order.orderNumber || '',
              listingId: order.listingId || '',
              adminRefund: 'true',
              platform: 'freshwax',
              type: 'vinyl_refund'
            }
          });
        } catch (stripeErr: unknown) {
          log.error('[vinyl/order refund] Stripe refund failed:', stripeErr);
          const stripeType = (stripeErr as Record<string, unknown>)?.type;
          if (stripeType === 'StripeCardError' || stripeType === 'StripeInvalidRequestError') {
            return ApiErrors.badRequest('Stripe refund request failed');
          }
          return ApiErrors.serverError('Failed to create Stripe refund');
        }

        const refundAmountPounds = refundAmountPence / 100;
        const totalRefunded = previouslyRefunded + refundAmountPounds;
        const now = new Date().toISOString();

        // 5. Update vinyl order with refund details
        await updateDocument('vinylOrders', orderId, {
          status: 'refunded',
          refundId: refund.id,
          refundedAt: now,
          refundAmount: refundAmountPounds,
          refundedAmount: totalRefunded,
          isFullRefund,
          updatedAt: now
        });

        // 6. Restore crate listing to published (if full refund)
        if (isFullRefund && order.listingId) {
          try {
            await updateDocument('vinylListings', order.listingId, {
              status: 'published',
              updatedAt: now
            });
            log.info('[vinyl/order refund] Listing restored to published:', order.listingId);
          } catch (listingErr: unknown) {
            log.error('[vinyl/order refund] Failed to restore listing:', listingErr);
          }
        }

        // 7. Record refund in refunds collection
        try {
          await addDocument('refunds', {
            orderId: parentOrderId,
            vinylOrderId: orderId,
            orderNumber: order.orderNumber || '',
            stripeRefundId: refund.id,
            stripePaymentIntentId: paymentIntentId,
            amount: refundAmountPounds,
            currency: 'gbp',
            reason: reason || 'requested_by_customer',
            isFullRefund,
            type: 'vinyl',
            listingId: order.listingId || '',
            sellerId: order.sellerId || '',
            sellerName: order.sellerName || '',
            customerEmail: order.buyer?.email || '',
            customerName: `${order.buyer?.firstName || ''} ${order.buyer?.lastName || ''}`.trim(),
            status: 'completed',
            createdAt: now
          });
        } catch (refundDocErr: unknown) {
          log.error('[vinyl/order refund] Failed to record refund doc:', refundDocErr);
        }

        // 8. Send customer refund confirmation email
        const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
        if (RESEND_API_KEY && order.buyer?.email) {
          try {
            const buyerEmailResp = await fetchWithTimeout('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'Fresh Wax <orders@freshwax.co.uk>',
                to: [order.buyer.email],
                subject: `Refund processed for vinyl order ${order.orderNumber || orderId}`,
                html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">Refund Processed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hi ${escapeHtml(order.buyer.firstName) || 'there'},
              </p>
              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                We've processed a ${isFullRefund ? 'full' : 'partial'} refund for your vinyl order <strong style="color: #ffffff;">${escapeHtml(order.orderNumber || orderId)}</strong>.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Item</td>
                        <td align="right" style="color: #f97316; font-size: 14px; font-weight: 600; padding-bottom: 10px;">${escapeHtml(order.title)}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Artist</td>
                        <td align="right" style="color: #ffffff; font-size: 14px; padding-bottom: 10px;">${escapeHtml(order.artist)}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Refund Amount</td>
                        <td align="right" style="color: #22c55e; font-size: 18px; font-weight: 700;">\u00a3${refundAmountPounds.toFixed(2)}</td>
                      </tr>
                      ${!isFullRefund ? `<tr>
                        <td style="color: #737373; font-size: 14px;">Total Refunded</td>
                        <td align="right" style="color: #ffffff; font-size: 14px;">\u00a3${totalRefunded.toFixed(2)}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 10px; line-height: 1.6;">
                The refund will appear in your account within 5-10 business days depending on your bank.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #0f0f0f; padding: 25px 40px; text-align: center; border-top: 1px solid #262626;">
              <p style="color: #525252; font-size: 12px; margin: 0;">Fresh Wax - Underground Music</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
              })
            }, 10000);
            if (!buyerEmailResp.ok) {
              log.error('[vinyl/order refund] Buyer refund email failed', { status: buyerEmailResp.status });
            } else {
              log.info('[vinyl/order refund] Buyer refund email sent');
            }
          } catch (emailErr: unknown) {
            log.error('[vinyl/order refund] Buyer email error:', emailErr);
          }
        }

        // 9. Send seller notification about the refund
        if (RESEND_API_KEY && order.sellerId) {
          try {
            // Look up seller email
            let sellerEmail = '';
            let seller = await getDocument('vinylSellers', order.sellerId);
            if (!seller) {
              seller = await getDocument('vinyl-sellers', order.sellerId);
            }
            if (seller) {
              sellerEmail = seller?.email || '';
            }
            if (!sellerEmail) {
              const user = await getDocument('users', order.sellerId);
              sellerEmail = user?.email || '';
            }

            if (sellerEmail) {
              const sellerEmailResp = await fetchWithTimeout('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${RESEND_API_KEY}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  from: 'Fresh Wax <orders@freshwax.co.uk>',
                  to: [sellerEmail],
                  subject: `Refund processed: ${order.title || 'Vinyl'} - #${order.orderNumber || orderId}`,
                  html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">Sale Refunded</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${escapeHtml(order.sellerName) || 'there'},
              </p>
              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                A ${isFullRefund ? 'full' : 'partial'} refund has been processed for your vinyl listing. ${isFullRefund ? 'Your listing has been restored and is available for sale again.' : ''}
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Order #</td>
                        <td align="right" style="color: #ffffff; font-size: 14px; padding-bottom: 10px;">${escapeHtml(order.orderNumber || orderId)}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Item</td>
                        <td align="right" style="color: #f97316; font-size: 14px; font-weight: 600; padding-bottom: 10px;">${escapeHtml(order.title)}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Refund Amount</td>
                        <td align="right" style="color: #ef4444; font-size: 18px; font-weight: 700;">-\u00a3${refundAmountPounds.toFixed(2)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="color: #a3a3a3; font-size: 14px; margin: 0; line-height: 1.6;">
                Any pending payout for this sale has been reversed. If you have questions, please contact us.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #0f0f0f; padding: 25px 40px; text-align: center; border-top: 1px solid #262626;">
              <p style="color: #525252; font-size: 12px; margin: 0;">Fresh Wax Crates - Vinyl Marketplace</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
                })
              }, 10000);
              if (!sellerEmailResp.ok) {
                log.error('[vinyl/order refund] Seller refund notification failed', { status: sellerEmailResp.status });
              } else {
                log.info('[vinyl/order refund] Seller refund notification sent to:', sellerEmail);
              }
            }
          } catch (sellerEmailErr: unknown) {
            log.error('[vinyl/order refund] Seller email error:', sellerEmailErr);
          }
        }

        return successResponse({ message: 'Vinyl order refunded',
          refundId: refund.id,
          amount: refundAmountPounds,
          totalRefunded,
          isFullRefund,
          listingRestored: isFullRefund && !!order.listingId });
      }

      case 'add-note': {
        const { note, adminId } = body;

        const notes = order.adminNotes || [];
        notes.push({
          note,
          adminId,
          createdAt: new Date().toISOString()
        });

        await updateDocument('vinylOrders', orderId, {
          adminNotes: notes,
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Note added' });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }
  } catch (error: unknown) {
    log.error('[API vinyl/order] Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
