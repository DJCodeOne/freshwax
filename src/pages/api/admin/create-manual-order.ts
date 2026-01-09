// src/pages/api/admin/create-manual-order.ts
// Admin endpoint to manually create an order (for recovery from failed payments)
// Uses service account for Firebase writes to bypass auth requirements

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { saSetDocument, saGetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { generateOrderNumber, getShortOrderNumber } from '../../../lib/order-utils';
import { createPayout, getPayPalConfig } from '../../../lib/paypal-payouts';

export const prerender = false;

// Build service account key from individual env vars
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

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const bodyData = await request.json();

    // Admin auth required
    const authError = requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    // Rate limit
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`admin-create-order:${clientId}`, RateLimiters.write);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // Get service account for Firebase writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ error: 'Firebase service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { orderData } = bodyData;

    if (!orderData) {
      return new Response(JSON.stringify({ error: 'orderData required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate required fields
    if (!orderData.customer?.email) {
      return new Response(JSON.stringify({ error: 'customer.email required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!orderData.items || orderData.items.length === 0) {
      return new Response(JSON.stringify({ error: 'items required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();
    const orderNumber = generateOrderNumber();

    // Set defaults
    const hasPhysicalItems = orderData.items.some((item: any) =>
      item.type === 'vinyl' || item.type === 'merch'
    );

    const subtotal = orderData.totals?.subtotal || orderData.items.reduce((sum: number, item: any) =>
      sum + ((item.price || 0) * (item.quantity || 1)), 0
    );

    const shipping = orderData.totals?.shipping ?? (hasPhysicalItems ? (subtotal >= 50 ? 0 : 4.99) : 0);
    const total = orderData.totals?.total ?? (subtotal + shipping);
    const freshWaxFee = orderData.totals?.freshWaxFee ?? (subtotal * 0.01);
    const stripeFee = orderData.totals?.stripeFee ?? ((total * 0.014) + 0.20);
    const serviceFees = orderData.totals?.serviceFees ?? (freshWaxFee + stripeFee);

    // Process items - fetch download URLs from releases
    const processedItems = await Promise.all(orderData.items.map(async (item: any) => {
      const releaseId = item.releaseId || item.id;
      let downloads = null;

      if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || !item.type)) {
        try {
          const release = await saGetDocument(serviceAccountKey, projectId, 'releases', releaseId);
          if (release) {
            downloads = {
              artistName: release.artistName || release.artist || item.artist || 'Unknown',
              releaseName: release.releaseName || release.title || item.name,
              artworkUrl: release.coverArtUrl || release.artworkUrl || release.thumbUrl || item.artwork,
              tracks: (release.tracks || []).map((t: any) => ({
                name: t.trackName || t.title || t.name,
                mp3Url: t.mp3Url || null,
                wavUrl: t.wavUrl || null
              }))
            };
          }
        } catch (e) {
          console.error('[admin] Error fetching release for downloads:', e);
        }
      }

      return {
        id: item.id || releaseId,
        releaseId: releaseId,
        productId: item.productId,
        trackId: item.trackId,
        name: item.name || 'Item',
        type: item.type || 'digital',
        price: item.price || 0,
        quantity: item.quantity || 1,
        size: item.size || null,
        color: item.color || null,
        image: item.image || item.artwork || null,
        artwork: item.artwork || item.image || null,
        artist: item.artist || null,
        artistId: item.artistId || null,
        downloads
      };
    }));

    // Build order document
    const order = {
      orderNumber,
      customer: {
        email: orderData.customer.email,
        firstName: orderData.customer.firstName || 'Manual',
        lastName: orderData.customer.lastName || 'Order',
        phone: orderData.customer.phone || '',
        userId: orderData.customer.userId || null
      },
      customerId: orderData.customer.userId || null,
      shipping: orderData.shipping || null,
      items: processedItems,
      totals: {
        subtotal,
        shipping,
        freshWaxFee,
        stripeFee,
        serviceFees,
        total
      },
      hasPhysicalItems,
      hasPreOrderItems: false,
      preOrderDeliveryDate: null,
      paymentMethod: orderData.paymentMethod || 'manual',
      paymentIntentId: orderData.paymentIntentId || null,
      paypalOrderId: orderData.paypalOrderId || null,
      paymentStatus: 'completed',
      status: hasPhysicalItems ? 'processing' : 'completed',
      orderStatus: hasPhysicalItems ? 'processing' : 'completed',
      createdAt: now,
      updatedAt: now,
      manuallyCreated: true,
      manualCreatedAt: now
    };

    // Generate a unique order ID
    const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    console.log('[admin] Creating manual order:', orderNumber, 'for:', order.customer.email);

    // Save order using service account
    await saSetDocument(serviceAccountKey, projectId, 'orders', orderId, order);

    console.log('[admin] Order created:', orderId, orderNumber);

    // Send confirmation email
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY && order.customer.email) {
      try {
        const shortOrderNumber = getShortOrderNumber(orderNumber);
        const emailHtml = buildOrderEmail(orderId, shortOrderNumber, order);

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <orders@freshwax.co.uk>',
            to: [order.customer.email],
            bcc: ['freshwaxonline@gmail.com'],
            subject: `Order Confirmed - ${shortOrderNumber}`,
            html: emailHtml
          })
        });

        if (emailResponse.ok) {
          console.log('[admin] Confirmation email sent');
        } else {
          console.error('[admin] Email failed:', await emailResponse.text());
        }
      } catch (emailErr) {
        console.error('[admin] Email error:', emailErr);
      }
    }

    // Send artist notification for digital sales
    const digitalItems = processedItems.filter((item: any) =>
      item.type === 'digital' || item.type === 'release' || item.type === 'track'
    );

    if (RESEND_API_KEY && digitalItems.length > 0) {
      for (const item of digitalItems) {
        if (item.artistId) {
          try {
            const artist = await saGetDocument(serviceAccountKey, projectId, 'artists', item.artistId);
            if (artist?.email) {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${RESEND_API_KEY}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  from: 'Fresh Wax <orders@freshwax.co.uk>',
                  to: [artist.email],
                  subject: `🎵 Digital Sale! ${orderNumber}`,
                  html: `<h2>Someone bought your music!</h2>
                    <p><strong>${item.name}</strong></p>
                    <p>Price: £${item.price.toFixed(2)}</p>
                    <p>Order: ${orderNumber}</p>
                    <p>Customer: ${order.customer.firstName} ${order.customer.lastName}</p>
                    <br><p>Payment will be processed to your configured payout method.</p>
                    <p>- Fresh Wax</p>`
                })
              });
              console.log('[admin] Artist notification sent to:', artist.email);
            }
          } catch (artistErr) {
            console.error('[admin] Artist notification error:', artistErr);
          }
        }
      }
    }

    // Process artist payouts automatically
    const paypalConfig = getPayPalConfig(env);
    const payoutResults: any[] = [];

    if (paypalConfig && digitalItems.length > 0) {
      console.log('[admin] Processing auto-payouts for digital items');

      // Calculate artist payments
      const artistPayments: Record<string, {
        artistId: string;
        artistName: string;
        paypalEmail: string | null;
        amount: number;
        items: string[];
      }> = {};

      for (const item of digitalItems) {
        const itemArtistId = item.artistId;
        if (!itemArtistId) continue;

        const artist = await saGetDocument(serviceAccountKey, projectId, 'artists', itemArtistId);
        const paypalEmail = artist?.paypalEmail || null;

        const itemTotal = (item.price || 0) * (item.quantity || 1);

        // Calculate artist share (subtract platform fees - Bandcamp style)
        // 1% Fresh Wax fee
        const freshWaxFee = itemTotal * 0.01;
        // PayPal fee: 1.4% + £0.20 (split fixed fee across items)
        const paypalFeePercent = 0.014;
        const paypalFixedFee = 0.20 / processedItems.length;
        const paypalFee = (itemTotal * paypalFeePercent) + paypalFixedFee;
        const artistShare = itemTotal - freshWaxFee - paypalFee;

        if (!artistPayments[itemArtistId]) {
          artistPayments[itemArtistId] = {
            artistId: itemArtistId,
            artistName: artist?.artistName || item.artist || 'Unknown Artist',
            paypalEmail,
            amount: 0,
            items: []
          };
        }

        artistPayments[itemArtistId].amount += artistShare;
        artistPayments[itemArtistId].items.push(item.name || 'Item');
      }

      // Process payouts for each artist
      for (const payment of Object.values(artistPayments)) {
        if (payment.amount <= 0) continue;

        if (!payment.paypalEmail) {
          payoutResults.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: payment.amount,
            status: 'skipped',
            reason: 'No PayPal email configured'
          });
          continue;
        }

        // Deduct 2% PayPal payout fee from artist share
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        console.log('[admin] Auto-paying', payment.artistName, '£' + paypalAmount.toFixed(2), 'via PayPal to', payment.paypalEmail, '(2% fee: £' + paypalPayoutFee.toFixed(2) + ')');

        try {
          const payoutResult = await createPayout(paypalConfig, {
            email: payment.paypalEmail,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax payout for order ${orderNumber}`,
            reference: `${orderId}-${payment.artistId}`
          });

          if (payoutResult.success) {
            // Record the payout
            const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            await saSetDocument(serviceAccountKey, projectId, 'payouts', payoutId, {
              artistId: payment.artistId,
              artistName: payment.artistName,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: payoutResult.batchId,
              paypalPayoutItemId: payoutResult.payoutItemId,
              orderId,
              orderNumber,
              amount: paypalAmount,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              payoutMethod: 'paypal',
              triggeredBy: 'auto-manual-order',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            // Update artist earnings
            const artistDoc = await saGetDocument(serviceAccountKey, projectId, 'artists', payment.artistId);
            if (artistDoc) {
              await saUpdateDocument(serviceAccountKey, projectId, 'artists', payment.artistId, {
                totalEarnings: (artistDoc.totalEarnings || 0) + paypalAmount,
                lastPayoutAt: new Date().toISOString()
              });
            }

            payoutResults.push({
              artistId: payment.artistId,
              artistName: payment.artistName,
              amount: paypalAmount,
              paypalFee: paypalPayoutFee,
              status: 'success',
              batchId: payoutResult.batchId
            });

            console.log('[admin] ✓ Auto-payout successful:', payoutResult.batchId);
          } else {
            payoutResults.push({
              artistId: payment.artistId,
              artistName: payment.artistName,
              amount: paypalAmount,
              status: 'failed',
              error: payoutResult.error
            });
            console.error('[admin] Auto-payout failed:', payoutResult.error);
          }
        } catch (err: any) {
          payoutResults.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: paypalAmount,
            status: 'error',
            error: err.message
          });
          console.error('[admin] Auto-payout error:', err.message);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      orderId,
      orderNumber,
      payouts: payoutResults,
      message: `Order ${orderNumber} created successfully`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin] Error creating manual order:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to create order'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Simple order confirmation email
function buildOrderEmail(orderId: string, orderNumber: string, order: any): string {
  let itemsHtml = '';
  for (const item of order.items) {
    itemsHtml += `<tr>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${item.name}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">£${(item.price * item.quantity).toFixed(2)}</td>
    </tr>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f3f4f6; padding: 40px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <div style="background: #000; padding: 24px; text-align: center;">
      <h1 style="margin: 0; color: white;"><span style="color: white;">FRESH</span> <span style="color: #dc2626;">WAX</span></h1>
    </div>
    <div style="padding: 32px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px;">✓</div>
        <h2 style="margin: 8px 0;">Order Confirmed!</h2>
        <p style="color: #666;">Order Number: <strong style="color: #dc2626;">${orderNumber}</strong></p>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="background: #f9fafb;">
          <th style="padding: 12px; text-align: left;">Item</th>
          <th style="padding: 12px; text-align: right;">Price</th>
        </tr>
        ${itemsHtml}
        <tr style="background: #000; color: white;">
          <td style="padding: 12px; font-weight: bold;">Total</td>
          <td style="padding: 12px; text-align: right; font-weight: bold;">£${order.totals.total.toFixed(2)}</td>
        </tr>
      </table>
      <div style="margin-top: 24px; padding: 16px; background: #dcfce7; border-radius: 8px;">
        <p style="margin: 0; color: #166534;"><strong>Your downloads are ready!</strong></p>
        <p style="margin: 8px 0 0; color: #166534;">Visit your account dashboard to download your music.</p>
      </div>
      <div style="text-align: center; margin-top: 24px;">
        <a href="https://freshwax.co.uk/account/dashboard" style="display: inline-block; padding: 12px 24px; background: #dc2626; color: white; text-decoration: none; border-radius: 8px;">Go to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
