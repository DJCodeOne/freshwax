// src/lib/stripe-webhook/subscriptions.ts
// Plus subscription handlers extracted from webhook.ts

import Stripe from 'stripe';
import { getDocument } from '../firebase-rest';
import { logStripeEvent } from '../webhook-logger';
import { fetchWithTimeout, createLogger } from '../api-utils';
import { activateSubscription } from './subscription-helpers';

const log = createLogger('stripe-webhook-subscriptions');

/** Context passed from the main webhook handler */
export interface SubscriptionContext {
  env: CloudflareEnv;
  requestUrl: string;
  startTime: number;
  eventType: string;
  eventId: string;
}

/**
 * Handle Plus subscription activation via checkout.session.completed (mode=subscription).
 * Updates user subscription in Firestore, sends welcome email, redeems referral codes.
 */
export async function handlePlusSubscription(
  session: Stripe.Checkout.Session,
  ctx: SubscriptionContext
): Promise<{ received: true; message?: string; error?: string }> {
  const { env, requestUrl, startTime, eventType, eventId } = ctx;

  // IDEMPOTENCY CHECK: Prevent duplicate processing of the same subscription session
  const metadata = session.metadata || {};
  const subUserId = metadata.userId;
  if (subUserId) {
    try {
      const userDoc = await getDocument('users', subUserId);
      const existingSub = (userDoc as Record<string, unknown> | null)?.subscription as Record<string, unknown> | undefined;
      if (existingSub && existingSub.subscriptionId === (session.subscription || session.id)) {
        log.debug('[Stripe Webhook] Subscription already processed for user:', subUserId);
        return { received: true, message: 'Subscription already processed' };
      }
    } catch (idempotencyErr: unknown) {
      log.error('[Stripe Webhook] Subscription idempotency check failed:', idempotencyErr);
      // Return error so Stripe retries when Firebase is back
      throw new IdempotencyError('Temporary error checking subscription status');
    }
  }

  // SECURITY: Validate payment amount matches Pro price (£10 = 1000 pence)
  const PRO_PRICE_PENCE = 1000; // £10.00
  if (session.payment_status !== 'paid') {
    log.error('[Stripe Webhook] SECURITY: Plus subscription payment not completed. Status:', session.payment_status);
    return { received: true, error: 'Payment not completed' };
  }
  if (session.amount_total != null && session.amount_total < PRO_PRICE_PENCE) {
    log.error('[Stripe Webhook] SECURITY: Plus payment amount too low:', session.amount_total, 'expected >=', PRO_PRICE_PENCE);
    return { received: true, error: 'Invalid payment amount' };
  }

  const userId = metadata.userId;
  const email = session.customer_email || metadata.email;

  if (userId) {
    await activateSubscription({
      userId,
      email,
      userName: metadata.userName,
      subscriptionId: (session.subscription || session.id) as string,
      promoCode: metadata.promoCode,
      referralCardId: metadata.referralCardId,
      isKvCode: metadata.isKvCode === 'true',
      env,
      requestUrl,
      startTime,
      eventType,
      eventId
    });
  }

  return { received: true };
}

/**
 * Handle one-off Plus payment via promo code (checkout.session.completed, mode=payment, type=plus_subscription).
 * Similar to handlePlusSubscription but uses payment_intent instead of subscription ID.
 */
export async function handlePlusPromoPayment(
  session: Stripe.Checkout.Session,
  ctx: SubscriptionContext
): Promise<{ received: true; message?: string }> {
  const { env, requestUrl, startTime, eventType, eventId } = ctx;
  const metadata = session.metadata || {};

  const userId = metadata.userId;
  const email = session.customer_email || metadata.email;
  const promoCode = metadata.promoCode;

  // IDEMPOTENCY CHECK: Prevent duplicate processing of the same promo subscription
  if (userId) {
    try {
      const userDoc = await getDocument('users', userId);
      const existingSub = (userDoc as Record<string, unknown> | null)?.subscription as Record<string, unknown> | undefined;
      if (existingSub && existingSub.subscriptionId === (session.payment_intent || session.id)) {
        log.debug('[Stripe Webhook] Promo subscription already processed for user:', userId);
        return { received: true, message: 'Subscription already processed' };
      }
    } catch (idempotencyErr: unknown) {
      log.error('[Stripe Webhook] Promo subscription idempotency check failed:', idempotencyErr);
      throw new IdempotencyError('Temporary error checking subscription status');
    }
  }

  if (userId) {
    await activateSubscription({
      userId,
      email,
      userName: metadata.userName,
      subscriptionId: (session.payment_intent || session.id) as string,
      promoCode: promoCode,
      referralCardId: metadata.referralCardId,
      isKvCode: metadata.isKvCode === 'true',
      env,
      requestUrl,
      startTime,
      eventType,
      eventId
    });
  }

  return { received: true };
}

/**
 * Handle subscription renewal (invoice.payment_succeeded with billing_reason=subscription_cycle).
 * Extends expiry by 1 year and sends renewal confirmation email.
 */
export async function handleSubscriptionRenewal(
  invoice: Stripe.Invoice,
  ctx: SubscriptionContext
): Promise<{ received: true; message?: string; error?: string }> {
  const { env, requestUrl } = ctx;

  // Only process subscription renewals, not initial payments
  if (invoice.billing_reason !== 'subscription_cycle' || !invoice.subscription) {
    return { received: true };
  }

  // Get subscription details from Stripe
  const stripeSecretKey = (env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY) as string;
  if (!stripeSecretKey) {
    return { received: true };
  }

  try {
    const subResponse = await fetchWithTimeout(
      `https://api.stripe.com/v1/subscriptions/${invoice.subscription}`,
      {
        headers: { 'Authorization': `Bearer ${stripeSecretKey}` }
      }
    );
    if (!subResponse.ok) {
      log.error(`[Stripe Webhook] Failed to fetch subscription: ${subResponse.status}`);
      return { received: true, error: 'Failed to fetch subscription' };
    }
    const subscription = await subResponse.json();

    if (subscription.metadata?.userId) {
      const userId = subscription.metadata.userId;
      const email = invoice.customer_email || subscription.metadata.email;

      // Calculate new expiry (extend by 1 year from current expiry or now)
      const FIREBASE_PROJECT_ID = (env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store') as string;
      const FIREBASE_API_KEY = (env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY) as string;

      // Get current user to check existing expiry
      const userResponse = await fetchWithTimeout(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?key=${FIREBASE_API_KEY}`
      );
      if (!userResponse.ok) {
        log.error(`[Stripe Webhook] Failed to fetch user: ${userResponse.status}`);
        return { received: true, error: 'Failed to fetch user' };
      }
      const userData = await userResponse.json();

      // IDEMPOTENCY CHECK: Skip if this exact invoice renewal was already applied
      const lastRenewalInvoice = userData.fields?.subscription?.mapValue?.fields?.lastRenewalInvoiceId?.stringValue;
      if (lastRenewalInvoice === invoice.id) {
        // Renewal already processed for this invoice
        return { received: true, message: 'Renewal already processed' };
      }

      let baseDate = new Date();
      if (userData.fields?.subscription?.mapValue?.fields?.expiresAt?.stringValue) {
        const currentExpiry = new Date(userData.fields.subscription.mapValue.fields.expiresAt.stringValue);
        if (currentExpiry > baseDate) {
          baseDate = currentExpiry; // Extend from current expiry if not yet expired
        }
      }

      const newExpiry = new Date(baseDate);
      newExpiry.setFullYear(newExpiry.getFullYear() + 1); // Add 1 year

      // Update subscription expiry
      const updateData: Record<string, unknown> = {
        fields: {
          'subscription': {
            mapValue: {
              fields: {
                tier: { stringValue: 'pro' },
                expiresAt: { stringValue: newExpiry.toISOString() },
                lastRenewal: { stringValue: new Date().toISOString() },
                lastRenewalInvoiceId: { stringValue: invoice.id },
                subscriptionId: { stringValue: invoice.subscription },
                paymentMethod: { stringValue: 'stripe' }
              } as Record<string, unknown>
            }
          }
        }
      };

      // Preserve existing fields
      const subFields = (updateData.fields as Record<string, unknown>);
      const subMap = (subFields.subscription as Record<string, unknown>).mapValue as Record<string, unknown>;
      const mapFields = subMap.fields as Record<string, unknown>;

      if (userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue) {
        mapFields.subscribedAt = userData.fields.subscription.mapValue.fields.subscribedAt;
      }
      if (userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue) {
        mapFields.plusId = userData.fields.subscription.mapValue.fields.plusId;
      }

      const updateResponse = await fetchWithTimeout(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        }
      );

      if (updateResponse.ok) {
        log.info('[Stripe Webhook] Subscription renewed:', userId, 'expires:', newExpiry.toISOString());

        // Send renewal confirmation email
        try {
          const origin = new URL(requestUrl).origin;
          const renewalEmailRes = await fetchWithTimeout(`${origin}/api/admin/send-plus-welcome-email/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email,
              name: subscription.metadata.userName || email?.split('@')[0],
              subscribedAt: userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue,
              expiresAt: newExpiry.toISOString(),
              plusId: userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue,
              isRenewal: true
            })
          });
          if (!renewalEmailRes.ok) {
            log.error(`[Stripe Webhook] Failed to send renewal email: ${renewalEmailRes.status}`);
          }
        } catch (emailError: unknown) {
          log.error('[Stripe Webhook] Failed to send renewal email:', emailError);
        }
      } else {
        log.error('[Stripe Webhook] Failed to update subscription on renewal');
      }
    } else {
      // No userId in subscription metadata
    }
  } catch (subError: unknown) {
    log.error('[Stripe Webhook] Error processing renewal:', subError);
  }

  return { received: true };
}

/**
 * Custom error class for idempotency check failures.
 * The main webhook handler should return 500 when this is thrown so Stripe retries.
 */
export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}
