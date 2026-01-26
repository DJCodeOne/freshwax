// src/pages/api/admin/send-artist-notification.ts
// Manually send artist sale notification email for an order
// Usage: GET /api/admin/send-artist-notification?orderNumber=FW-xxx&send=yes

import type { APIRoute } from 'astro';
import { initFirebaseEnv, queryCollection, getDocument } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';

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
      <td style="padding: 12px; border-bottom: 1px solid #333;">
        <div style="font-weight: 600; color: #fff;">${item.name || item.title}</div>
        <div style="font-size: 13px; color: #888;">Digital Download</div>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #333; text-align: right; color: #10b981;">
        £${(item.price || 0).toFixed(2)}
      </td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #111; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px; text-align: center;">
              <div style="font-size: 32px; margin-bottom: 8px;">🎵</div>
              <h1 style="margin: 0; color: #fff; font-size: 24px; font-weight: 700;">You Made a Sale!</h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Order ${shortOrderNumber}</p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <p style="color: #ccc; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
                Great news! Someone just purchased your music on Fresh Wax.
              </p>

              <!-- Items -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding: 12px; background: #1a1a1a; border-radius: 8px 8px 0 0; font-weight: 600; color: #888; font-size: 12px; text-transform: uppercase;">Item</td>
                  <td style="padding: 12px; background: #1a1a1a; border-radius: 8px 8px 0 0; font-weight: 600; color: #888; font-size: 12px; text-transform: uppercase; text-align: right;">Price</td>
                </tr>
                ${itemsHtml}
              </table>

              <!-- Payout Info -->
              <div style="background: #1a1a1a; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color: #888; padding-bottom: 8px;">Pending Payout</td>
                    <td style="color: #10b981; font-weight: 700; font-size: 20px; text-align: right; padding-bottom: 8px;">£${artistPayout.toFixed(2)}</td>
                  </tr>
                </table>
                <p style="color: #666; font-size: 13px; margin: 12px 0 0; line-height: 1.5;">
                  After Fresh Wax fee (1%) and customer payment processing fees.<br>
                  <span style="color: #888;">Bank transfer: no additional fee</span><br>
                  <span style="color: #888;">PayPal instant: 2% fee applies</span>
                </p>
              </div>

              <!-- CTA -->
              <div style="text-align: center; margin-top: 32px;">
                <a href="https://freshwax.co.uk/artist/dashboard" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">
                  View Your Dashboard
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px; background: #0a0a0a; text-align: center; border-top: 1px solid #222;">
              <p style="color: #666; font-size: 13px; margin: 0;">
                Thank you for being part of Fresh Wax!
              </p>
              <p style="color: #444; font-size: 12px; margin: 12px 0 0;">
                <a href="https://freshwax.co.uk" style="color: #ef4444; text-decoration: none;">freshwax.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const send = url.searchParams.get('send') === 'yes';

  if (!orderNumber) {
    return new Response(JSON.stringify({
      error: 'Missing orderNumber',
      usage: '/api/admin/send-artist-notification?orderNumber=FW-xxx&send=yes'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const env = (locals as any)?.runtime?.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  const serviceAccountKey = getServiceAccountKey(env);

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // Find order
    const orders = await queryCollection('orders', {
      filters: [{ field: 'orderNumber', op: 'EQUAL', value: orderNumber }],
      limit: 1
    });

    if (orders.length === 0) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const order = orders[0];
    const orderId = order.id;
    const digitalItems = (order.items || []).filter((item: any) =>
      item.type === 'digital' || item.type === 'release' || item.type === 'track'
    );

    if (digitalItems.length === 0) {
      return new Response(JSON.stringify({ error: 'No digital items in order' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get pending payouts for this order to get actual amounts
    let pendingPayouts: any[] = [];
    if (serviceAccountKey) {
      try {
        pendingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
          filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
          limit: 10
        });
      } catch (e) {
        console.log('[send-artist-notification] Could not fetch pending payouts');
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
      return new Response(JSON.stringify({ error: 'Could not find artist email for any items' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
      return new Response(JSON.stringify({ error: 'Resend API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
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

        const response = await fetch('https://api.resend.com/emails', {
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
        });

        if (response.ok) {
          const result = await response.json();
          sent.push({ email: artistEmail, success: true, id: result.id });
        } else {
          const error = await response.text();
          sent.push({ email: artistEmail, success: false, error });
        }
      } catch (e) {
        sent.push({ email: artistEmail, success: false, error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    results.emailsSent = sent;

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[send-artist-notification] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
