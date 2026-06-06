// src/lib/order/email-sender.ts
// Send all order-related emails (confirmation, stockist, digital artist, merch seller)
// Extracted from create-order.ts (pure extraction, zero behavior changes)

import { updateDocument, getDocument } from '../firebase-rest';
import { fetchWithTimeout, createLogger, maskEmail } from '../api-utils';
import { buildOrderConfirmationEmail, buildStockistFulfillmentEmail, buildDigitalSaleEmail, buildMerchSaleEmail } from './create-order-emails';
import type { OrderItem } from './create-order-emails';
import { esc } from '../email-wrapper';
import { SITE_URL } from '../constants';

const log = createLogger('create-order');

interface SendOrderEmailsParams {
  order: Record<string, unknown>;
  orderRefId: string;
  orderNumber: string;
  env: Record<string, unknown>;
}

/**
 * Send all order-related emails: confirmation to buyer, fulfillment to stockist,
 * digital sale notifications to artists, merch sale notifications to sellers.
 * Also marks vinyl crates listings as sold.
 * Errors are logged but never fail the order.
 */
export async function sendOrderEmails({ order, orderRefId, orderNumber, env }: SendOrderEmailsParams): Promise<void> {
  // Send confirmation email directly
  try {
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (RESEND_API_KEY && order.customer?.email) {
      log.info('[create-order] Sending email to:', maskEmail(order.customer.email));

      // Extract short order number for customer display (e.g., "FW-ABC123" from "FW-241204-abc123")
      const orderParts = orderNumber.split('-');
      const shortOrderNumber = orderParts.length >= 3
        ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
        : orderNumber.toUpperCase();

      const emailHtml = buildOrderConfirmationEmail(orderRefId, shortOrderNumber, order);

      const emailResponse = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Fresh Wax <orders@freshwax.co.uk>',
          to: [order.customer.email],
          bcc: ['freshwaxonline@gmail.com'],
          subject: 'Order Confirmed - ' + shortOrderNumber,
          html: emailHtml
        })
      }, 10000);

      if (emailResponse.ok) {
        const emailResult = await emailResponse.json();
        log.info('[create-order] ✓ Email sent! ID:', emailResult.id);
      } else {
        const error = await emailResponse.text();
        log.error('[create-order] ❌ Email failed:', error);
      }
    } else {
      log.info('[create-order] Skipping email - no API key or no customer email');
    }
  } catch (emailError: unknown) {
    log.error('[create-order] Email error:', emailError);
    // Don't fail the order if email fails
  }

  // Send fulfillment email for vinyl orders. Originally there was one shared
  // stockist address; now we group by artistEmail so each artist/label gets
  // their own fulfillment email with the buyer's shipping address (matches the
  // pattern used by sendDigitalSaleEmails). STOCKIST_EMAIL still receives a
  // BCC so the central team has full oversight, and items whose artistEmail
  // is missing fall back to going straight to the stockist as before.
  const vinylItems = order.items.filter((item: OrderItem) => item.type === 'vinyl');
  if (vinylItems.length > 0) {
    try {
      const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
      const STOCKIST_EMAIL = env?.VINYL_STOCKIST_EMAIL || import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

      if (RESEND_API_KEY && STOCKIST_EMAIL) {
        // Group items by artist email; items without an artistEmail are
        // bucketed under STOCKIST_EMAIL for central fulfillment.
        const groups: { [email: string]: OrderItem[] } = {};
        for (const item of vinylItems) {
          const target = (item.artistEmail as string | undefined) || STOCKIST_EMAIL;
          if (!groups[target]) groups[target] = [];
          groups[target].push(item);
        }

        for (const [recipientEmail, recipientItems] of Object.entries(groups)) {
          const goesToStockist = recipientEmail === STOCKIST_EMAIL;
          const bccList = goesToStockist
            ? ['freshwaxonline@gmail.com']
            : [STOCKIST_EMAIL, 'freshwaxonline@gmail.com'];

          log.info('[create-order] Sending vinyl fulfillment email to:', maskEmail(recipientEmail));
          const fulfillmentHtml = buildStockistFulfillmentEmail(orderRefId, orderNumber, order, recipientItems);

          const fulfillmentResponse = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
              to: [recipientEmail],
              bcc: bccList,
              subject: '📦 VINYL FULFILLMENT REQUIRED - ' + orderNumber,
              html: fulfillmentHtml
            })
          }, 10000);

          if (fulfillmentResponse.ok) {
            const result = await fulfillmentResponse.json();
            log.info('[create-order] ✓ Vinyl fulfillment email sent! ID:', result.id);
          } else {
            const error = await fulfillmentResponse.text();
            log.error('[create-order] ❌ Vinyl fulfillment email failed:', error);
          }
        }
      }
    } catch (stockistError: unknown) {
      log.error('[create-order] Vinyl fulfillment email error:', stockistError);
      // Don't fail the order if fulfillment email fails
    }

    // Mark vinyl crates listings as sold (single-item listings from marketplace sellers)
    for (const vItem of vinylItems) {
      if (vItem.sellerId && !vItem.releaseId) {
        const listingId = vItem.id || vItem.productId;
        if (listingId) {
          try {
            await updateDocument('vinylListings', listingId, {
              status: 'sold',
              soldAt: new Date().toISOString(),
              orderId: orderRefId,
              orderNumber
            });
            log.info('[create-order] Marked vinyl listing as sold:', listingId);
          } catch (vinylErr: unknown) {
            log.error('[create-order] Failed to mark vinyl as sold:', listingId, vinylErr);
          }
        }
      }
    }
  }

  // Send notification emails to digital payees (artists / labels).
  // Resolved using the same logic as processArtistPayments so we always
  // notify everyone who'll get money from the order:
  //   - For releases with a `payoutSplits` array, every recipient.
  //   - Otherwise, the release.artistId account.
  // The email lists the specific track/release titles tied to the
  // recipient's payouts (so a 50/50 split release shows up on both
  // recipients' emails). Buyer name + totals are intentionally omitted.
  const digitalItems = order.items.filter((item: OrderItem) => item.type === 'track' || item.type === 'digital' || item.type === 'release');
  if (digitalItems.length > 0) {
    const RESEND_API_KEY = (env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY) as string | undefined;
    if (RESEND_API_KEY) {
      try {
        // Resolve unique payee artistIds, batching release fetches.
        const releaseIds = new Set<string>();
        for (const item of digitalItems) {
          const releaseId = (item.releaseId || item.productId || item.id) as string | undefined;
          if (releaseId) releaseIds.add(releaseId);
        }
        const releaseEntries = await Promise.all(
          [...releaseIds].map(async (id) => [id, await getDocument('releases', id).catch(() => null)] as const)
        );
        const releaseMap = new Map(releaseEntries.filter(([, doc]) => doc));

        // Build per-payee item lists. A track on a 50/50 split release
        // gets attributed to BOTH payees (each one knows what sold).
        const itemsByPayeeId = new Map<string, OrderItem[]>();
        for (const item of digitalItems) {
          const releaseId = (item.releaseId || item.productId || item.id) as string | undefined;
          if (!releaseId) continue;
          const release = releaseMap.get(releaseId) as Record<string, unknown> | undefined;
          if (!release) continue;
          const splits = (release.payoutSplits as Array<{ artistId?: unknown; percentage?: unknown }> | undefined);
          const recipients: string[] = [];
          if (Array.isArray(splits) && splits.length > 0) {
            for (const s of splits) {
              if (typeof s.artistId === 'string' && typeof s.percentage === 'number' && s.percentage > 0) {
                recipients.push(s.artistId);
              }
            }
          } else {
            const aid = (item.artistId || (release as { artistId?: string; userId?: string }).artistId || (release as { artistId?: string; userId?: string }).userId) as string | undefined;
            if (aid) recipients.push(aid);
          }
          for (const aid of recipients) {
            const list = itemsByPayeeId.get(aid) || [];
            list.push(item);
            itemsByPayeeId.set(aid, list);
          }
        }

        // Fetch each payee's account doc for email + display name.
        const payeeEntries = await Promise.all(
          [...itemsByPayeeId.keys()].map(async (id) => {
            const [artistDoc, userDoc] = await Promise.all([
              getDocument('artists', id).catch(() => null),
              getDocument('users', id).catch(() => null),
            ]);
            const email = (artistDoc?.email || userDoc?.email) as string | undefined;
            const name = (artistDoc?.artistName || artistDoc?.displayName || userDoc?.displayName || userDoc?.name || 'Artist') as string;
            return { id, email, name, items: itemsByPayeeId.get(id) || [] };
          })
        );

        // Helper: a friendly title string for a single order item. Tracks
        // get "Track Title (from Release)"; full releases just the title.
        const formatItem = (item: OrderItem): string => {
          const isTrack = item.type === 'track';
          // The downloads.tracks array (set by create-order) is the
          // authoritative source for the track title actually sold.
          const downloadTracks = (item as OrderItem & { downloads?: { tracks?: Array<{ name?: string }>; releaseName?: string } }).downloads;
          const trackName = downloadTracks?.tracks?.[0]?.name;
          const releaseName = downloadTracks?.releaseName || item.title;
          if (isTrack && trackName) {
            // Avoid "X (from X)" when track and release share the same name
            if (releaseName && releaseName !== trackName) {
              return `${esc(trackName)} <span style="color:#999;">(from ${esc(releaseName)})</span>`;
            }
            return esc(trackName);
          }
          return esc(item.name || item.title || 'Untitled');
        };

        // Send one email per unique email address. Items are deduped
        // within each payee's list (multiple line items for the same
        // track shouldn't appear twice).
        const sentTo = new Set<string>();
        for (const payee of payeeEntries) {
          if (!payee.email || sentTo.has(payee.email)) continue;
          sentTo.add(payee.email);

          // Dedupe items by their formatted title so we don't list the
          // same track twice if it appears on multiple line items.
          const seenTitles = new Set<string>();
          const itemRows: string[] = [];
          for (const item of payee.items) {
            const html = formatItem(item);
            const key = html.toLowerCase();
            if (seenTitles.has(key)) continue;
            seenTitles.add(key);
            itemRows.push(`<li style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#fff;">${html}</li>`);
          }
          const itemsHtml = itemRows.length
            ? `<ul style="margin:0 0 24px;padding-left:20px;list-style:disc;">${itemRows.join('')}</ul>`
            : '';
          const itemWord = itemRows.length === 1 ? 'this' : 'these';

          log.info('[create-order] Sending payee sale notification to:', maskEmail(payee.email), `(${itemRows.length} item(s))`);

          // On-brand template matching buildDigitalSaleEmail's structure:
          // white FRESH WAX header card + red announcement strip + dark
          // content panel with 2px red outline. Content is intentionally
          // simple — just track titles + dashboard CTA, no buyer name,
          // no totals.
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#000;"><tr><td align="center" style="padding:40px 20px;">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
      <tr><td style="background:#fff;padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;border:2px solid #dc2626;border-bottom:none;">
        <div style="font-size:32px;font-weight:900;letter-spacing:2px;line-height:1;"><span style="color:#000;">FRESH</span> <span style="color:#dc2626;">WAX</span></div>
        <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:3px;font-weight:600;">JUNGLE &bull; DRUM AND BASS</div>
      </td></tr>
      <tr><td style="background:#dc2626;padding:18px 24px;text-align:center;border-left:2px solid #dc2626;border-right:2px solid #dc2626;">
        <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:1px;">🎵 NEW SALE!</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.9);margin-top:4px;">Order ${esc(orderNumber)}</div>
      </td></tr>
      <tr><td style="background:#111;padding:32px 28px;border-left:2px solid #dc2626;border-right:2px solid #dc2626;border-bottom:2px solid #dc2626;border-radius:0 0 12px 12px;">
        <p style="font-size:18px;line-height:1.5;margin:0 0 12px;color:#fff;font-weight:700;">Ez ${esc(payee.name)} 👋</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 20px;color:#d1d5db;">Someone just bought ${itemWord} on Fresh Wax:</p>
        <div style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:18px 20px;margin:0 0 24px;">
          ${itemRows.length ? `<ul style="margin:0;padding:0 0 0 20px;list-style:disc;">${itemRows.join('')}</ul>` : '<p style="margin:0;color:#9ca3af;">No items.</p>'}
        </div>
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding:6px 0 22px;">
          <a href="${SITE_URL}/account/dashboard/" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:0.5px;text-transform:uppercase;">View Dashboard</a>
        </td></tr></table>
        <p style="font-size:12px;line-height:1.5;color:#9ca3af;margin:0 0 14px;text-align:center;">Your dashboard shows your share &amp; payout status. Payouts are processed manually.</p>
        <div style="background:#1f2937;border:1px solid #374151;border-radius:6px;padding:12px 16px;margin:0;">
          <p style="font-size:11px;line-height:1.5;color:#9ca3af;margin:0 0 4px;text-align:left;"><strong style="color:#fff;">Withdrawal fees:</strong></p>
          <p style="font-size:11px;line-height:1.5;color:#9ca3af;margin:0;text-align:left;">&bull; <span style="color:#fff;">PayPal</span> &mdash; PayPal's typical mass-payout fee (around &pound;0.20 GBP domestic, higher for international) is deducted from your payout. You'll receive the amount minus that fee.<br>&bull; <span style="color:#fff;">Stripe Connect</span> &mdash; no fee, but standard payouts take a few working days to land in your bank.</p>
        </div>
      </td></tr>
      <tr><td align="center" style="padding:22px 0 0;">
        <div style="color:#9ca3af;font-size:12px;">Automated notification from FreshWax</div>
        <div style="margin-top:6px;"><a href="${SITE_URL}" style="font-size:12px;text-decoration:none;font-weight:600;"><span style="color:#fff;">fresh</span><span style="color:#dc2626;">wax</span><span style="color:#fff;">.co.uk</span></a></div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

          const response = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Fresh Wax <orders@freshwax.co.uk>',
              to: [payee.email],
              bcc: ['freshwaxonline@gmail.com'],
              subject: '🎵 You have a new sale on Fresh Wax',
              html,
            }),
          }, 10000);

          if (response.ok) {
            log.info('[create-order] ✓ Payee notification sent to:', maskEmail(payee.email));
          } else {
            const error = await response.text();
            log.error('[create-order] ❌ Payee notification failed:', error);
          }
        }

        if (sentTo.size === 0 && digitalItems.length > 0) {
          log.warn('[create-order] No payee emails resolved for digital items in order:', orderNumber);
        }
      } catch (payeeErr: unknown) {
        log.error('[create-order] Payee notification error:', payeeErr);
      }
    }
  }

  // Send notification emails to merch sellers
  const merchItems = order.items.filter((item: OrderItem) => item.type === 'merch');
  if (merchItems.length > 0) {
    try {
      const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

      // Group items by seller email (use stockistEmail or artistEmail)
      const itemsBySeller: { [email: string]: OrderItem[] } = {};
      for (const item of merchItems) {
        const sellerEmail = item.stockistEmail || item.artistEmail || item.sellerEmail;
        if (sellerEmail) {
          if (!itemsBySeller[sellerEmail]) {
            itemsBySeller[sellerEmail] = [];
          }
          itemsBySeller[sellerEmail].push(item);
        }
      }

      // Send email to each seller
      for (const [sellerEmail, items] of Object.entries(itemsBySeller)) {
        if (RESEND_API_KEY && sellerEmail) {
          log.info('[create-order] Sending merch sale email to seller:', maskEmail(sellerEmail));

          const merchHtml = buildMerchSaleEmail(orderNumber, order, items);

          const merchResponse = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
              to: [sellerEmail],
              bcc: ['freshwaxonline@gmail.com'],
              subject: '👕 Merch Order! ' + orderNumber,
              html: merchHtml
            })
          }, 10000);

          if (merchResponse.ok) {
            log.info('[create-order] ✓ Merch sale email sent to:', maskEmail(sellerEmail));
          } else {
            const error = await merchResponse.text();
            log.error('[create-order] ❌ Merch sale email failed:', error);
          }
        }
      }
    } catch (merchError: unknown) {
      log.error('[create-order] Merch sale email error:', merchError);
    }
  }
}
