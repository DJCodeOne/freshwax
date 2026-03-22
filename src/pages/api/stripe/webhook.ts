// src/pages/api/stripe/webhook.ts
// Handles Stripe webhook events for product checkouts
//
// D1 MIGRATION REQUIRED — run this against your D1 database:
// -------------------------------------------------------
// CREATE TABLE IF NOT EXISTS pending_orders (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   stripe_session_id TEXT UNIQUE NOT NULL,
//   customer_email TEXT,
//   amount_total INTEGER,
//   currency TEXT DEFAULT 'gbp',
//   items TEXT,
//   status TEXT DEFAULT 'pending',
//   firebase_order_id TEXT,
//   created_at TEXT DEFAULT (datetime('now')),
//   updated_at TEXT DEFAULT (datetime('now'))
// );
// -------------------------------------------------------

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection } from '../../../lib/firebase-rest';
import { logStripeEvent } from '../../../lib/webhook-logger';
import { formatPrice } from '../../../lib/format-utils';
import { fetchWithTimeout, createLogger, jsonResponse, errorResponse, timingSafeCompare} from '../../../lib/api-utils';

// Extracted modules
import { handleDisputeCreated, handleDisputeClosed } from '../../../lib/stripe-webhook/disputes';
import { handleRefund } from '../../../lib/stripe-webhook/refund';
import { handlePlusSubscription, handlePlusPromoPayment, handleSubscriptionRenewal, IdempotencyError } from '../../../lib/stripe-webhook/subscriptions';
import { handleCheckoutExpired } from '../../../lib/stripe-webhook/abandoned-cart';
import { handleProductOrder, handleGiftCardPurchase, OrderIdempotencyError, GiftCardIdempotencyError } from '../../../lib/stripe-webhook/product-order';

const log = createLogger('stripe-webhook');

export const prerender = false;

// Stripe webhook signature verification
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    // Parse the signature header
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
    const v1Signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !v1Signature) {
      log.error('[Stripe Webhook] Missing signature components');
      return false;
    }

    // Check timestamp is within tolerance (5 minutes)
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
      log.error('[Stripe Webhook] Timestamp too old');
      return false;
    }

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(signedPayload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBytes = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return timingSafeCompare(expectedSignature, v1Signature);
  } catch (error: unknown) {
    log.error('[Stripe Webhook] Signature verification error:', error);
    return false;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();

  try {
    const env = locals.runtime.env;

    // Get webhook secret
    const webhookSecret = env?.STRIPE_WEBHOOK_SECRET || import.meta.env.STRIPE_WEBHOOK_SECRET;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    log.debug('[Stripe Webhook] Environment check:');
    log.debug('[Stripe Webhook]   - webhookSecret exists:', !!webhookSecret);
    log.debug('[Stripe Webhook]   - stripeSecretKey exists:', !!stripeSecretKey);
    log.debug('[Stripe Webhook]   - env from locals:', !!env);

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    log.debug('[Stripe Webhook]   - Firebase projectId:', projectId || 'MISSING');
    log.debug('[Stripe Webhook]   - Firebase apiKey exists:', !!apiKey);

    // Get raw body for signature verification
    const payload = await request.text();
    const signature = request.headers.get('stripe-signature');

    log.debug('[Stripe Webhook] Request details:');
    log.debug('[Stripe Webhook]   - Payload length:', payload.length);
    log.debug('[Stripe Webhook]   - Signature exists:', !!signature);
    log.debug('[Stripe Webhook]   - Signature preview:', signature ? signature.substring(0, 50) + '...' : 'none');

    // SECURITY: Signature verification is REQUIRED in production
    // Only skip in development if explicitly configured
    const isDevelopment = import.meta.env.DEV;

    if (!signature) {
      log.error('[Stripe Webhook] Missing signature header - REJECTING REQUEST');
      return jsonResponse({ error: 'Missing signature' }, 401);
    }

    let event: Stripe.Event;

    if (webhookSecret && stripeSecretKey) {
      log.debug('[Stripe Webhook] Verifying signature with official Stripe SDK...');
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
        // Use constructEventAsync for Cloudflare Workers (Web Crypto API)
        event = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
        log.debug('[Stripe Webhook] Signature verified successfully via Stripe SDK');
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log.error('[Stripe Webhook] Stripe signature verification failed:', errMessage);
        return jsonResponse({ error: 'Invalid signature' }, 401);
      }
    } else if (!isDevelopment) {
      // In production, REQUIRE webhook secret
      log.error('[Stripe Webhook] SECURITY: Webhook secret not configured in production - REJECTING');
      return jsonResponse({ error: 'Webhook not configured' }, 500);
    } else {
      log.debug('[Stripe Webhook] DEV MODE: Skipping signature verification');
      try {
        event = JSON.parse(payload);
      } catch (parseErr: unknown) {
        log.error('[Stripe Webhook] Invalid JSON payload:', parseErr instanceof Error ? parseErr.message : String(parseErr));
        return jsonResponse({ error: 'Invalid JSON payload' }, 400);
      }
    }
    log.info('[Stripe Webhook] Event:', event.type, event.id || 'no-id');

    // Shared context for handler functions
    const ctx = {
      env,
      stripeSecretKey,
      requestUrl: request.url,
      startTime,
      eventType: event.type,
      eventId: event.id
    };

    // Handle checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Handle Plus subscription
      if (session.mode === 'subscription') {
        try {
          const result = await handlePlusSubscription(session, ctx);
          return jsonResponse(result);
        } catch (err: unknown) {
          if (err instanceof IdempotencyError) {
            log.warn('[Stripe Webhook] Plus subscription idempotency:', err.message);
            return jsonResponse({ error: 'Payment already processed' }, 500);
          }
          throw err;
        }
      }

      // Handle one-off Plus payment (promo code purchases)
      if (session.mode === 'payment') {
        const metadata = session.metadata || {};

        // Check if this is a Plus subscription payment (promo)
        if (metadata.type === 'plus_subscription') {
          try {
            const result = await handlePlusPromoPayment(session, ctx);
            return jsonResponse(result);
          } catch (err: unknown) {
            if (err instanceof IdempotencyError) {
              log.warn('[Stripe Webhook] Plus promo idempotency:', err.message);
              return jsonResponse({ error: 'Payment already processed' }, 500);
            }
            throw err;
          }
        }
      }

      // Handle gift card purchases
      const metadata = session.metadata || {};
      if (metadata.type === 'giftcard') {
        try {
          const result = await handleGiftCardPurchase(session, ctx);
          return jsonResponse(result);
        } catch (err: unknown) {
          if (err instanceof GiftCardIdempotencyError) {
            log.warn('[Stripe Webhook] Gift card idempotency:', err.message);
            return errorResponse('Duplicate event', 500);
          }
          throw err;
        }
      }

      // Handle product order
      try {
        const result = await handleProductOrder(session, ctx);
        if (result !== null) {
          // Handler returned a response (skip, error, or idempotency)
          if (result.error && !result.orderId) {
            return jsonResponse({ error: result.error }, 500);
          }
          return jsonResponse(result);
        }
        // result === null means success, fall through to final return
      } catch (err: unknown) {
        if (err instanceof OrderIdempotencyError) {
          log.warn('[Stripe Webhook] Order idempotency:', err.message);
          return jsonResponse({ error: 'Duplicate event' }, 500);
        }
        throw err;
      }
    }

    // Handle payment_intent.succeeded (backup for session complete)
    if (event.type === 'payment_intent.succeeded') {
      // Order should already be created by checkout.session.completed
    }

    // Handle subscription renewal (invoice.payment_succeeded for recurring payments)
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const result = await handleSubscriptionRenewal(invoice, ctx);
      return jsonResponse(result);
    }

    // Handle subscription cancelled/expired
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      // Subscription cancelled

      // User's subscription has been cancelled - they'll naturally lose Plus when expiresAt passes
      // The getEffectiveTier() function handles this automatically
      // Optionally, we could immediately downgrade or send a cancellation email here
    }

    // Handle dispute created - reverse transfers to recover funds from artists
    if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      log.info('[Stripe Webhook] Dispute created:', dispute.id, dispute.reason, dispute.amount / 100);

      // IDEMPOTENCY CHECK: Skip if dispute already recorded
      try {
        const existingDisputes = await queryCollection('disputes', {
          filters: [{ field: 'stripeDisputeId', op: 'EQUAL', value: dispute.id }],
          limit: 1
        });
        if (existingDisputes && existingDisputes.length > 0) {
          // Dispute already recorded
          return jsonResponse({ received: true, message: 'Dispute already processed' });
        }
      } catch (idempotencyErr: unknown) {
        log.error('[Stripe Webhook] Dispute idempotency check failed:', idempotencyErr);
        // Return 500 so Stripe retries when Firebase is back
        return jsonResponse({ error: 'Temporary error checking dispute status' }, 500);
      }

      await handleDisputeCreated(dispute, stripeSecretKey);

      logStripeEvent(event.type, event.id, true, {
        message: `Dispute created: ${dispute.reason}`,
        metadata: { disputeId: dispute.id, chargeId: dispute.charge, amount: dispute.amount / 100 },
        processingTimeMs: Date.now() - startTime
      }).catch(e => log.error('[Stripe Webhook] Log error:', e));
    }

    // Handle dispute closed - track outcome
    if (event.type === 'charge.dispute.closed') {
      const dispute = event.data.object;
      log.info('[Stripe Webhook] Dispute closed:', dispute.id, dispute.status);

      await handleDisputeClosed(dispute, stripeSecretKey);

      logStripeEvent(event.type, event.id, true, {
        message: `Dispute closed: ${dispute.status}`,
        metadata: { disputeId: dispute.id, status: dispute.status },
        processingTimeMs: Date.now() - startTime
      }).catch(e => log.error('[Stripe Webhook] Log error:', e));
    }

    // Handle checkout.session.expired - release reserved stock + send recovery email
    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      await handleCheckoutExpired(session, env);
    }

    // Handle refund - reverse artist transfers proportionally
    if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      log.info('[Stripe Webhook] Refund processed:', charge.id, charge.amount_refunded / 100);

      await handleRefund(charge, stripeSecretKey, env);

      logStripeEvent(event.type, event.id, true, {
        message: `Refund processed: ${formatPrice(charge.amount_refunded / 100)}`,
        metadata: { chargeId: charge.id, amountRefunded: charge.amount_refunded / 100 },
        processingTimeMs: Date.now() - startTime
      }).catch(e => log.error('[Stripe Webhook] Log error:', e));
    }

    return jsonResponse({ received: true });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[Stripe Webhook] Error:', errorMessage);

    // Log error
    logStripeEvent('webhook_error', 'unknown', false, {
      message: 'Webhook processing error',
      error: errorMessage
    }).catch(e => log.error('[Stripe Webhook] Log error:', e));
    return jsonResponse({ error: 'An internal error occurred' }, 500);
  }
};
