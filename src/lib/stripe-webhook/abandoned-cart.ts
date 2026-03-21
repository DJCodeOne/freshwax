// src/lib/stripe-webhook/abandoned-cart.ts
// Abandoned cart (checkout expired) handler extracted from webhook.ts

import Stripe from 'stripe';
import { getDocument, queryCollection, addDocument } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-abandoned-cart');

/**
 * Handle checkout.session.expired — release reserved stock and send recovery email.
 */
export async function handleCheckoutExpired(
  session: Stripe.Checkout.Session,
  env: CloudflareEnv
): Promise<void> {
  log.info('[Stripe Webhook] Checkout session expired:', session.id);

  const reservationId = session.metadata?.reservation_id;
  if (reservationId) {
    try {
      const { releaseReservation } = await import('../order-utils');
      await releaseReservation(reservationId);
      // Reservation released
    } catch (err: unknown) {
      log.error('[Stripe Webhook] Failed to release reservation:', err);
    }
  }

  // Send abandoned cart recovery email
  const customerEmail = session.customer_email || session.customer_details?.email;
  const itemsMeta = session.metadata?.items;
  if (customerEmail && itemsMeta) {
    try {
      let items: Record<string, unknown>[] = [];
      try { items = JSON.parse(itemsMeta); } catch (e: unknown) { /* intentional: items_json metadata may be malformed — proceed with empty items */ }

      if (items.length > 0) {
        // Check email opt-out (forward-compatible)
        let optedOut = false;
        const userId = session.metadata?.userId || session.metadata?.customer_id;
        if (userId) {
          try {
            const userDoc = await getDocument('customers', userId);
            if (userDoc && (userDoc as Record<string, unknown>).emailOptOut) {
              optedOut = true;
            }
          } catch (e: unknown) { /* user not found, proceed */ }
        }

        if (!optedOut) {
          // Rate limit: max 1 per email per 24h
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const recentEmails = await queryCollection('abandonedCartEmails', {
            filters: [
              { field: 'email', op: 'EQUAL', value: customerEmail },
              { field: 'sentAt', op: 'GREATER_THAN_OR_EQUAL', value: oneDayAgo }
            ]
          });

          if (!recentEmails || recentEmails.length === 0) {
            const { sendAbandonedCartEmail } = await import('../abandoned-cart-email');
            const customerName = session.customer_details?.name || session.metadata?.customerName || null;
            const total = (session.amount_total || 0) / 100;

            const emailResult = await sendAbandonedCartEmail(customerEmail, customerName, items, total, env);

            // Log to Firestore for analytics
            await addDocument('abandonedCartEmails', {
              email: customerEmail,
              sessionId: session.id,
              itemCount: items.length,
              total,
              sent: emailResult.success,
              messageId: emailResult.messageId || null,
              error: emailResult.error || null,
              sentAt: new Date().toISOString()
            });

            log.debug('[Stripe Webhook] Abandoned cart email:', emailResult.success ? 'sent' : 'failed');
          } else {
            log.debug('[Stripe Webhook] Abandoned cart email rate-limited');
          }
        } else {
          log.debug('[Stripe Webhook] Customer opted out of emails');
        }
      }
    } catch (emailErr: unknown) {
      log.error('[Stripe Webhook] Abandoned cart email error:', emailErr);
    }
  }
}
