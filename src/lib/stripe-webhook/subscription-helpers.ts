// src/lib/stripe-webhook/subscription-helpers.ts
// Shared helpers for Plus subscription activation (used by both regular and promo flows)

import { redeemReferralCode } from '../referral-codes';
import { logStripeEvent } from '../webhook-logger';
import { fetchWithTimeout, createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-subscription-helpers');

export interface SubscriptionActivationParams {
  userId: string;
  email?: string | null;
  userName?: string;
  subscriptionId: string;
  promoCode?: string | null;
  referralCardId?: string | null;
  isKvCode?: boolean;
  env: CloudflareEnv;
  requestUrl: string;
  startTime: number;
  eventType: string;
  eventId: string;
}

/**
 * Generate a Plus ID from userId.
 */
export function generatePlusId(userId: string): string {
  const year = new Date().getFullYear().toString().slice(-2);
  const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
  const userHash = userId.slice(-4).toUpperCase();
  return `FWP-${year}${month}-${userHash}`;
}

/**
 * Activate a Plus subscription for a user.
 * Shared logic between regular subscription and promo payment flows.
 */
export async function activateSubscription(params: SubscriptionActivationParams): Promise<void> {
  const { userId, email, userName, subscriptionId, promoCode, referralCardId, isKvCode, env, requestUrl, startTime, eventType, eventId } = params;

  const subscribedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const plusId = generatePlusId(userId);

  const FIREBASE_PROJECT_ID = (env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store') as string;
  const FIREBASE_API_KEY = (env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY) as string;

  const subscriptionFields: Record<string, Record<string, string>> = {
    tier: { stringValue: 'pro' },
    subscribedAt: { stringValue: subscribedAt },
    expiresAt: { stringValue: expiresAt },
    subscriptionId: { stringValue: subscriptionId },
    plusId: { stringValue: plusId },
    paymentMethod: { stringValue: 'stripe' },
  };

  if (promoCode) {
    subscriptionFields.promoCode = { stringValue: promoCode };
  }

  const updateData = {
    fields: {
      'subscription': {
        mapValue: { fields: subscriptionFields }
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
      log.info('[subscription] User subscription activated:', userId);

      // Send welcome email
      try {
        const origin = new URL(requestUrl).origin;
        const welcomeEmailRes = await fetchWithTimeout(`${origin}/api/admin/send-plus-welcome-email/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            name: userName || email?.split('@')[0],
            subscribedAt,
            expiresAt,
            plusId,
            isRenewal: false
          })
        });
        if (!welcomeEmailRes.ok) {
          log.error(`[subscription] Failed to send Plus welcome email: ${welcomeEmailRes.status}`);
        } else {
          log.debug('[subscription] Welcome email sent');
        }
      } catch (emailError: unknown) {
        log.error('[subscription] Failed to send welcome email:', emailError);
      }

      // Redeem referral code if one was used
      await redeemReferralCodeIfPresent({
        referralCardId,
        isKvCode,
        promoCode,
        userId,
        env,
        FIREBASE_PROJECT_ID,
        FIREBASE_API_KEY
      });

      // Log successful subscription
      logStripeEvent(eventType, eventId, true, {
        message: `Plus subscription activated for ${userId}`,
        metadata: { userId, plusId, promoCode: promoCode || null },
        processingTimeMs: Date.now() - startTime
      }).catch(e => log.error('[subscription] Log error:', e));
    } else {
      log.error('[subscription] Failed to update user subscription');
      logStripeEvent(eventType, eventId, false, {
        message: 'Failed to update user subscription',
        error: 'Firestore update failed'
      }).catch(e => log.error('[subscription] Log error:', e));
    }
  } catch (updateError: unknown) {
    log.error('[subscription] Error updating subscription:', updateError);
    logStripeEvent(eventType, eventId, false, {
      message: 'Error updating subscription',
      error: updateError instanceof Error ? updateError.message : 'Unknown error'
    }).catch(e => log.error('[subscription] Log error:', e));
  }
}

/**
 * Redeem a referral code (KV or legacy Firebase) if one was provided.
 */
async function redeemReferralCodeIfPresent(params: {
  referralCardId?: string | null;
  isKvCode?: boolean;
  promoCode?: string | null;
  userId: string;
  env: CloudflareEnv;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
}): Promise<void> {
  const { referralCardId, isKvCode, promoCode, userId, env, FIREBASE_PROJECT_ID, FIREBASE_API_KEY } = params;

  if (isKvCode && promoCode) {
    // New KV-based referral code system
    try {
      const kv = env?.CACHE as KVNamespace | undefined;
      if (kv) {
        const result = await redeemReferralCode(kv, promoCode, userId);
        if (result.success) {
          log.debug(`[subscription] KV referral code ${promoCode} marked as redeemed by ${userId}`);
        } else {
          log.error('[subscription] KV referral redemption error:', result.error);
        }
      }
    } catch (referralError: unknown) {
      log.error('[subscription] Failed to mark KV referral code as redeemed:', referralError);
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
        log.error(`[subscription] Failed to redeem referral gift card in Firestore: ${redeemRes.status}`);
      } else {
        log.debug(`[subscription] Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
      }
    } catch (referralError: unknown) {
      log.error('[subscription] Failed to mark Firebase referral code as redeemed:', referralError);
    }
  }
}
