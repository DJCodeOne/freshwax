// src/pages/api/admin/send-artist-notification.ts
// Manually send artist sale notification email for an order
// Usage: GET /api/admin/send-artist-notification/?orderNumber=FW-xxx&send=yes

import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { createLogger, fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[send-artist-notification]');
import { emailWrapper, ctaButton, detailBox, esc as escWrap } from '../../../lib/email-wrapper';

export const prerender = false;

function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

function buildDigitalSaleEmail(orderNumber: string, order: any, items: any[], artistName: string, artistPayout: number): string {
  const shortOrderNumber = orderNumber.split('-').length >= 3
    ? `${orderNumber.split('-')[0]}-${orderNumber.split('-').pop()}`.toUpperCase()
    : orderNumber;

  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #333; border-color: #333;" class="border-subtle">
        <div style="font-weight: 600; color: #ffffff;" class="text-primary">${escWrap(item.name || item.title)}</div>
        <div style="font-size: 13px; color: #737373;" class="text-muted">Digital Download</div>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #333; text-align: right; color: #10b981; border-color: #333;" class="border-subtle">
        \u00a3${(item.price || 0).toFixed(2)}
      </td>
    </tr>
  `).join('');

  const content = `
              <p style="color: #a3a3a3; font-size: 15px; line-height: 1.6; margin: 0 0 24px;" class="text-secondary">
                Great news! Someone just purchased your music on Fresh Wax.
              </p>

              <!-- Items -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding: 12px; background: #1f1f1f; border-radius: 8px 8px 0 0; font-weight: 600; color: #737373; font-size: 12px; text-transform: uppercase;" class="detail-box text-muted">Item</td>
                  <td style="padding: 12px; background: #1f1f1f; border-radius: 8px 8px 0 0; font-weight: 600; color: #737373; font-size: 12px; text-transform: uppercase; text-align: right;" class="detail-box text-muted">Price</td>
                </tr>
                ${itemsHtml}
              </table>

              ${detailBox([
                { label: 'Pending Payout', value: '\u00a3' + artistPayout.toFixed(2), valueColor: '#10b981' },
              ])}

              <p style="color: #737373; font-size: 13px; margin: 0 0 24px; line-height: 1.5;" class="text-muted">
                After Fresh Wax fee (1%) and customer payment processing fees.<br>
                <span style="color: #a3a3a3;" class="text-secondary">Bank transfer: no additional fee</span><br>
                <span style="color: #a3a3a3;" class="text-secondary">PayPal instant: 2% fee applies</span>
              </p>

              ${ctaButton('View Your Dashboard', SITE_URL + '/artist/dashboard', { gradient: 'linear-gradient(135deg, #10b981 0%, #059669 100%)' })}

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;" class="text-muted">
                Thank you for being part of Fresh Wax!
              </p>`;

  return emailWrapper(content, {
    title: 'You Made a Sale!',
    headerText: `You Made a Sale! Order ${escWrap(shortOrderNumber)}`,
    headerGradient: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`send-artist-notification:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const send = url.searchParams.get('send') === 'yes';

  if (!orderNumber) {
    return ApiErrors.badRequest('Missing orderNumber');
  }

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  const serviceAccountKey = getServiceAccountKey(env);

  const saQuery = getSaQuery(locals);

  try {
    // Find order
    const orders = await saQuery('orders', {
      filters: [{ field: 'orderNumber', op: 'EQUAL', value: orderNumber }],
      limit: 1
    });

    if (orders.length === 0) {
      return ApiErrors.notFound('Order not found');
    }

    const order = orders[0];
    const orderId = order.id;
    const digitalItems = (order.items || []).filter((item: any) =>
      item.type === 'digital' || item.type === 'release' || item.type === 'track'
    );

    if (digitalItems.length === 0) {
      return ApiErrors.badRequest('No digital items in order');
    }

    // Get pending payouts for this order to get actual amounts
    let pendingPayouts: any[] = [];
    if (serviceAccountKey) {
      try {
        pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
          filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
          limit: 10
        });
      } catch (e: unknown) {
        log.info('Could not fetch pending payouts');
      }
    }

    // Get artist info from releases and match with pending payouts
    const artistEmails: { [email: string]: { items: any[], artistName: string, payout: number } } = {};

    for (const item of digitalItems) {
      const releaseId = item.releaseId || item.productId || item.id;
      if (!releaseId) continue;

      const release = await getDocument('releases', releaseId);
      if (!release) continue;

      const artistEmail = release.email || release.artistEmail || release.submitterEmail;
      if (!artistEmail) continue;

      // Try to find the actual payout amount from pending payouts
      const artistId = release.submitterId || release.userId;
      const matchingPayout = pendingPayouts.find(p => p.artistId === artistId || p.artistEmail === artistEmail);

      // Use actual payout amount if found, otherwise calculate estimate
      let artistPayout = 0;
      if (matchingPayout) {
        artistPayout = matchingPayout.amount || 0;
      } else {
        // Fallback to estimate
        const itemTotal = (item.price || 0) * (item.quantity || 1);
        const freshWaxFee = itemTotal * 0.01;
        const processingFee = (itemTotal * 0.029) + 0.30;
        artistPayout = itemTotal - freshWaxFee - processingFee;
      }

      if (!artistEmails[artistEmail]) {
        artistEmails[artistEmail] = {
          items: [],
          artistName: release.artistName || release.artist || 'Artist',
          payout: matchingPayout ? matchingPayout.amount : 0
        };
      }

      artistEmails[artistEmail].items.push(item);
      // Only add payout if we didn't get it from pendingPayouts (to avoid double counting)
      if (!matchingPayout) {
        artistEmails[artistEmail].payout += artistPayout;
      }
    }

    if (Object.keys(artistEmails).length === 0) {
      return ApiErrors.badRequest('Could not find artist email for any items');
    }

    const results: any = {
      orderNumber,
      artists: Object.entries(artistEmails).map(([email, data]) => ({
        email,
        artistName: data.artistName,
        itemCount: data.items.length,
        payout: Math.round(data.payout * 100) / 100
      }))
    };

    if (!send) {
      results.message = 'Add &send=yes to send the notification emails';
      return new Response(JSON.stringify(results, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!RESEND_API_KEY) {
      return ApiErrors.serverError('Resend API key not configured');
    }

    // Send emails
    const sent: any[] = [];
    for (const [artistEmail, data] of Object.entries(artistEmails)) {
      try {
        const emailHtml = buildDigitalSaleEmail(
          orderNumber,
          order,
          data.items,
          data.artistName,
          data.payout
        );

        const response = await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <orders@freshwax.co.uk>',
            to: [artistEmail],
            bcc: ['freshwaxonline@gmail.com'],
            subject: `🎵 Digital Sale! ${orderNumber}`,
            html: emailHtml
          })
        }, 10000);

        if (response.ok) {
          const result = await response.json();
          sent.push({ email: artistEmail, success: true, id: result.id });
        } else {
          const error = await response.text();
          sent.push({ email: artistEmail, success: false, error });
        }
      } catch (e: unknown) {
        sent.push({ email: artistEmail, success: false, error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    results.emailsSent = sent;

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
