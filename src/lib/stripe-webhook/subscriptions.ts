// src/lib/stripe-webhook/subscriptions.ts
// Plus subscription handlers extracted from webhook.ts

import Stripe from 'stripe';
import { getDocument } from '../firebase-rest';
import { redeemReferralCode } from '../referral-codes';
import { logStripeEvent } from '../webhook-logger';
import { fetchWithTimeout, createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-subscriptions');

/** Context passed from the main webhook handler */
export interface SubscriptionContext {
  env: Record<string, unknown>;
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
    // Calculate subscription dates
    const subscribedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

    // Generate Plus ID
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const userHash = userId.slice(-4).toUpperCase();
    const plusId = `FWP-${year}${month}-${userHash}`;

    // Update user subscription in Firestore
    const FIREBASE_PROJECT_ID = (env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store') as string;
    const FIREBASE_API_KEY = (env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY) as string;

    const updateData = {
      fields: {
        'subscription': {
          mapValue: {
            fields: {
              tier: { stringValue: 'pro' },
              subscribedAt: { stringValue: subscribedAt },
              expiresAt: { stringValue: expiresAt },
              subscriptionId: { stringValue: session.subscription || session.id },
              plusId: { stringValue: plusId },
              paymentMethod: { stringValue: 'stripe' }
            }
          }
        }
      }
    };

    try {
      const updateResponse = await fetchWithTimeout(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        }
      );

      if (updateResponse.ok) {
        log.info('[Stripe Webhook] User subscription updated:', userId);

        // Send welcome email
        try {
          const origin = new URL(requestUrl).origin;
          const welcomeEmailRes = await fetchWithTimeout(`${origin}/api/admin/send-plus-welcome-email/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email,
              name: metadata.userName || email?.split('@')[0],
              subscribedAt,
              expiresAt,
              plusId,
              isRenewal: false
            })
          });
          if (!welcomeEmailRes.ok) {
            log.error(`[Stripe Webhook] Failed to send Plus welcome email: ${welcomeEmailRes.status}`);
          } else {
            log.debug('[Stripe Webhook] Welcome email sent');
          }

          // Mark referral code as redeemed if one was used
          const referralCardId = metadata.referralCardId;
          const isKvCode = metadata.isKvCode === 'true';
          const promoCodeUsed = metadata.promoCode;

          if (isKvCode && promoCodeUsed) {
            // New KV-based referral code system
            try {
              const kv = env?.CACHE as KVNamespace | undefined;
              if (kv) {
                const result = await redeemReferralCode(kv, promoCodeUsed, userId);
                if (result.success) {
                  log.debug(`[Stripe Webhook] KV referral code ${promoCodeUsed} marked as redeemed by ${userId}`);
                } else {
                  log.error('[Stripe Webhook] KV referral redemption error:', result.error);
                }
              }
            } catch (referralError: unknown) {
              log.error('[Stripe Webhook] Failed to mark KV referral code as redeemed:', referralError);
            }
          } else if (referralCardId) {
            // Legacy Firebase giftCards system
            try {
              const redeemData = {
                fields: {
                  redeemedBy: { stringValue: userId },
                  redeemedAt: { stringValue: new Date().toISOString() },
                  isActive: { booleanValue: false }
                }
              };

              const redeemRes = await fetchWithTimeout(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/giftCards/${referralCardId}?updateMask.fieldPaths=redeemedBy&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=isActive&key=${FIREBASE_API_KEY}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(redeemData)
                }
              );
              if (!redeemRes.ok) {
                log.error(`[Stripe Webhook] Failed to redeem referral gift card in Firestore: ${redeemRes.status}`);
              } else {
                log.debug(`[Stripe Webhook] Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
              }
            } catch (referralError: unknown) {
              log.error('[Stripe Webhook] Failed to mark Firebase referral code as redeemed:', referralError);
            }
          }

          // Log successful subscription
          logStripeEvent(eventType, eventId, true, {
            message: `Plus subscription activated for ${userId}`,
            metadata: { userId, plusId, promoCode: promoCodeUsed || null },
            processingTimeMs: Date.now() - startTime
          }).catch(e => log.error('[Stripe Webhook] Log error:', e));
        } catch (emailError: unknown) {
          log.error('[Stripe Webhook] Failed to send welcome email:', emailError);
        }
      } else {
        log.error('[Stripe Webhook] Failed to update user subscription');
        logStripeEvent(eventType, eventId, false, {
          message: 'Failed to update user subscription',
          error: 'Firestore update failed'
        }).catch(e => log.error('[Stripe Webhook] Log error:', e));
      }
    } catch (updateError: unknown) {
      log.error('[Stripe Webhook] Error updating subscription:', updateError);
      logStripeEvent(eventType, eventId, false, {
        message: 'Error updating subscription',
        error: updateError instanceof Error ? updateError.message : 'Unknown error'
      }).catch(e => log.error('[Stripe Webhook] Log error:', e));
    }
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
    // Calculate subscription dates
    const subscribedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

    // Generate Plus ID
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const userHash = userId.slice(-4).toUpperCase();
    const plusId = `FWP-${year}${month}-${userHash}`;

    // Update user subscription in Firestore
    const FIREBASE_PROJECT_ID = (env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store') as string;
    const FIREBASE_API_KEY = (env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY) as string;

    const updateData = {
      fields: {
        'subscription': {
          mapValue: {
            fields: {
              tier: { stringValue: 'pro' },
              subscribedAt: { stringValue: subscribedAt },
              expiresAt: { stringValue: expiresAt },
              subscriptionId: { stringValue: session.payment_intent || session.id },
              plusId: { stringValue: plusId },
              paymentMethod: { stringValue: 'stripe' },
              promoCode: { stringValue: promoCode || '' }
            }
          }
        }
      }
    };

    try {
      const updateResponse = await fetchWithTimeout(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        }
      );

      if (updateResponse.ok) {
        log.info('[Stripe Webhook] User Plus subscription activated (promo):', userId);

        // Send welcome email
        try {
          const origin = new URL(requestUrl).origin;
          const welcomeEmailRes = await fetchWithTimeout(`${origin}/api/admin/send-plus-welcome-email/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email,
              name: metadata.userName || email?.split('@')[0],
              subscribedAt,
              expiresAt,
              plusId,
              isRenewal: false
            })
          });
          if (!welcomeEmailRes.ok) {
            log.error(`[Stripe Webhook] Failed to send Plus welcome email (promo): ${welcomeEmailRes.status}`);
          } else {
            log.debug('[Stripe Webhook] Welcome email sent');
          }
        } catch (emailError: unknown) {
          log.error('[Stripe Webhook] Failed to send welcome email:', emailError);
        }

        // Mark referral code as redeemed
        const referralCardId = metadata.referralCardId;
        const isKvCode = metadata.isKvCode === 'true';

        if (isKvCode && promoCode) {
          // Redeem KV-based referral code
          try {
            const kv = env?.CACHE as KVNamespace | undefined;
            if (kv) {
              const result = await redeemReferralCode(kv, promoCode, userId);
              if (result.success) {
                log.debug(`[Stripe Webhook] KV referral code ${promoCode} marked as redeemed by ${userId}`);
              } else {
                log.error(`[Stripe Webhook] Failed to redeem KV code: ${result.error}`);
              }
            }
          } catch (referralError: unknown) {
            log.error('[Stripe Webhook] Failed to mark KV referral code as redeemed:', referralError);
          }
        } else if (referralCardId) {
          // Redeem Firebase-based referral code (legacy)
          try {
            const redeemData = {
              fields: {
                redeemedBy: { stringValue: userId },
                redeemedAt: { stringValue: new Date().toISOString() },
                isActive: { booleanValue: false }
              }
            };

            const redeemRes = await fetchWithTimeout(
              `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/giftCards/${referralCardId}?updateMask.fieldPaths=redeemedBy&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=isActive&key=${FIREBASE_API_KEY}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(redeemData)
              }
            );
            if (!redeemRes.ok) {
              log.error(`[Stripe Webhook] Failed to redeem referral gift card in Firestore (promo): ${redeemRes.status}`);
            } else {
              log.debug(`[Stripe Webhook] Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
            }
          } catch (referralError: unknown) {
            log.error('[Stripe Webhook] Failed to mark Firebase referral code as redeemed:', referralError);
          }
        }

        logStripeEvent(eventType, eventId, true, {
          message: `Plus subscription activated via promo for ${userId}`,
          metadata: { userId, plusId, promoCode },
          processingTimeMs: Date.now() - startTime
        }).catch(e => log.error('[Stripe Webhook] Log error:', e));
      } else {
        log.error('[Stripe Webhook] Failed to update user subscription (promo)');
      }
    } catch (updateError: unknown) {
      log.error('[Stripe Webhook] Error updating subscription (promo):', updateError);
    }
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
