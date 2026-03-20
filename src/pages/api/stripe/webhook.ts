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
import { createOrder, validateStock } from '../../../lib/order-utils';
import { getDocument, queryCollection, deleteDocument, addDocument, updateDocument, atomicIncrement, arrayUnion, invalidateReleasesCache, clearAllMerchCache } from '../../../lib/firebase-rest';
import { kvDelete, CACHE_CONFIG } from '../../../lib/kv-cache';
import { logStripeEvent } from '../../../lib/webhook-logger';
import { redeemReferralCode } from '../../../lib/referral-codes';
import { createGiftCardAfterPayment } from '../../../lib/giftcard';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';
import { formatPrice } from '../../../lib/format-utils';
import { fetchWithTimeout, createLogger, jsonResponse, errorResponse, timingSafeCompare} from '../../../lib/api-utils';

// Extracted modules
import { processArtistPayments, processSupplierPayments, getCountryName } from '../../../lib/stripe-webhook/payments';
import { processVinylCrateSellerPayments } from '../../../lib/stripe-webhook/vinyl-crate-payments';
import { handleDisputeCreated, handleDisputeClosed } from '../../../lib/stripe-webhook/disputes';
import { handleRefund } from '../../../lib/stripe-webhook/refund';

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
      log.error('[Stripe Webhook] ❌ Missing signature header - REJECTING REQUEST');
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
        log.error('[Stripe Webhook] ❌ Stripe signature verification failed:', errMessage);
        return jsonResponse({ error: 'Invalid signature' }, 401);
      }
    } else if (!isDevelopment) {
      // In production, REQUIRE webhook secret
      log.error('[Stripe Webhook] ❌ SECURITY: Webhook secret not configured in production - REJECTING');
      return jsonResponse({ error: 'Webhook not configured' }, 500);
    } else {
      log.debug('[Stripe Webhook] DEV MODE: Skipping signature verification');
      try {
        event = JSON.parse(payload);
      } catch (parseErr: unknown) {
        log.error('[Stripe Webhook] ❌ Invalid JSON payload:', parseErr instanceof Error ? parseErr.message : String(parseErr));
        return jsonResponse({ error: 'Invalid JSON payload' }, 400);
      }
    }
    log.info('[Stripe Webhook] Event:', event.type, event.id || 'no-id');

    // Handle checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // Session details available in event data for debugging if needed

      // Handle Plus subscription
      if (session.mode === 'subscription') {
        // Process Plus subscription

        // IDEMPOTENCY CHECK: Prevent duplicate processing of the same subscription session
        const metadata = session.metadata || {};
        const subUserId = metadata.userId;
        if (subUserId) {
          try {
            const userDoc = await getDocument('users', subUserId);
            const existingSub = userDoc?.subscription;
            if (existingSub && existingSub.subscriptionId === (session.subscription || session.id)) {
              log.debug('[Stripe Webhook] Subscription already processed for user:', subUserId);
              return jsonResponse({ received: true, message: 'Subscription already processed' });
            }
          } catch (idempotencyErr: unknown) {
            log.error('[Stripe Webhook] Subscription idempotency check failed:', idempotencyErr);
            // Return 500 so Stripe retries when Firebase is back
            return jsonResponse({ error: 'Temporary error checking subscription status' }, 500);
          }
        }

        // SECURITY: Validate payment amount matches Pro price (£10 = 1000 pence)
        const PRO_PRICE_PENCE = 1000; // £10.00
        if (session.payment_status !== 'paid') {
          log.error('[Stripe Webhook] SECURITY: Plus subscription payment not completed. Status:', session.payment_status);
          return jsonResponse({ received: true, error: 'Payment not completed' });
        }
        if (session.amount_total != null && session.amount_total < PRO_PRICE_PENCE) {
          log.error('[Stripe Webhook] SECURITY: Plus payment amount too low:', session.amount_total, 'expected >=', PRO_PRICE_PENCE);
          return jsonResponse({ received: true, error: 'Invalid payment amount' });
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
          const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
          const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

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
                const origin = new URL(request.url).origin;
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
                logStripeEvent(event.type, event.id, true, {
                  message: `Plus subscription activated for ${userId}`,
                  metadata: { userId, plusId, promoCode: promoCodeUsed || null },
                  processingTimeMs: Date.now() - startTime
                }).catch(e => log.error('[Stripe Webhook] Log error:', e));
              } catch (emailError: unknown) {
                log.error('[Stripe Webhook] Failed to send welcome email:', emailError);
              }
            } else {
              log.error('[Stripe Webhook] Failed to update user subscription');
              logStripeEvent(event.type, event.id, false, {
                message: 'Failed to update user subscription',
                error: 'Firestore update failed'
              }).catch(e => log.error('[Stripe Webhook] Log error:', e));
            }
          } catch (updateError: unknown) {
            log.error('[Stripe Webhook] Error updating subscription:', updateError);
            logStripeEvent(event.type, event.id, false, {
              message: 'Error updating subscription',
              error: updateError instanceof Error ? updateError.message : 'Unknown error'
            }).catch(e => log.error('[Stripe Webhook] Log error:', e));
          }
        }

        return jsonResponse({ received: true });
      }

      // Handle one-off Plus payment (promo code purchases)
      if (session.mode === 'payment') {
        const metadata = session.metadata || {};

        // Check if this is a Plus subscription payment (promo)
        if (metadata.type === 'plus_subscription') {
          // Process Plus one-off payment (promo)

          const userId = metadata.userId;
          const email = session.customer_email || metadata.email;
          const promoCode = metadata.promoCode;

          // IDEMPOTENCY CHECK: Prevent duplicate processing of the same promo subscription
          if (userId) {
            try {
              const userDoc = await getDocument('users', userId);
              const existingSub = userDoc?.subscription;
              if (existingSub && existingSub.subscriptionId === (session.payment_intent || session.id)) {
                log.debug('[Stripe Webhook] Promo subscription already processed for user:', userId);
                return jsonResponse({ received: true, message: 'Subscription already processed' });
              }
            } catch (idempotencyErr: unknown) {
              log.error('[Stripe Webhook] Promo subscription idempotency check failed:', idempotencyErr);
              return jsonResponse({ error: 'Temporary error checking subscription status' }, 500);
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
            const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
            const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

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
                  const origin = new URL(request.url).origin;
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

                logStripeEvent(event.type, event.id, true, {
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

          return jsonResponse({ received: true });
        }
      }

      // Extract order data from metadata
      const metadata = session.metadata || {};
      log.debug('[Stripe Webhook] Metadata keys:', Object.keys(metadata).join(', '));

      // Handle gift card purchases
      if (metadata.type === 'giftcard') {
        // Processing gift card purchase

        const paymentIntentId = session.payment_intent;

        // Idempotency check for gift cards
        if (paymentIntentId) {
          try {
            const existingCards = await queryCollection('giftCards', {
              filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
              limit: 1,
              throwOnError: true
            });

            if (existingCards.length > 0) {
              log.debug('[Stripe Webhook] Gift card already exists for this payment:', existingCards[0].code);
              return jsonResponse({
                received: true,
                message: 'Gift card already created',
                code: existingCards[0].code
              });
            }
          } catch (checkErr: unknown) {
            log.error('[Stripe Webhook] Gift card idempotency check failed:', checkErr);
            return errorResponse('Gift card idempotency check failed — retry later', 500);
          }
        }

        // Create the gift card
        const result = await createGiftCardAfterPayment({
          amount: parseInt(metadata.amount),
          buyerUserId: metadata.buyerUserId,
          buyerEmail: metadata.buyerEmail,
          buyerName: metadata.buyerName || '',
          recipientType: metadata.recipientType as 'gift' | 'self',
          recipientName: metadata.recipientName || '',
          recipientEmail: metadata.recipientEmail,
          message: metadata.message || '',
          paymentIntentId: paymentIntentId as string
        }, {
          queryCollection,
          addDocument,
          updateDocument,
          getDocument
        });

        if (result.success) {
          log.info('[Stripe Webhook] Gift card created:', result.giftCard?.code);
          log.debug('[Stripe Webhook] Gift card email sent:', result.emailSent);
        } else {
          log.error('[Stripe Webhook] ❌ Failed to create gift card:', result.error);
        }

        return jsonResponse({
          received: true,
          giftCard: result.success,
          code: result.giftCard?.code
        });
      }

      // Skip if no customer email (not a valid order)
      if (!metadata.customer_email) {
        log.debug('[Stripe Webhook] No customer email in metadata - skipping');
        log.debug('[Stripe Webhook] Available metadata keys:', Object.keys(metadata).join(', '));
        return jsonResponse({ received: true });
      }

      // IDEMPOTENCY CHECK: Check if order already exists for this payment intent
      // Uses throwOnError=true so Firebase outages return 500 (Stripe retries) instead of creating duplicates
      const paymentIntentId = session.payment_intent;
      if (paymentIntentId) {
        // Check for existing order (idempotency)
        try {
          const existingOrders = await queryCollection('orders', {
            filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
            limit: 1
          }, true);

          if (existingOrders && existingOrders.length > 0) {
            // Order already processed - skip duplicate
            return jsonResponse({
              received: true,
              message: 'Order already exists',
              orderId: existingOrders[0].id
            });
          }
          // No existing order - proceed with creation
        } catch (idempotencyErr: unknown) {
          log.error('[Stripe Webhook] Idempotency check failed (Firebase unreachable):', idempotencyErr);
          // Return 500 so Stripe retries later when Firebase is back up
          // This prevents duplicate orders when we can't verify idempotency
          return jsonResponse({
            error: 'Temporary error checking order status. Will retry.',
          }, 500);
        }
      }

      // Parse items from metadata or retrieve from pending checkout
      let items: Record<string, unknown>[] = [];

      // Track artist shipping breakdown for payouts (artist gets item price + their shipping fee)
      let artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> | null = null;

      // First try items_json in metadata
      if (metadata.items_json) {
        try {
          items = JSON.parse(metadata.items_json);
        } catch (e: unknown) {
          log.error('[Stripe Webhook] ❌ Error parsing items_json:', e);
          log.error('[Stripe Webhook] items_json value:', metadata.items_json?.substring(0, 200));
        }
      }

      // If no items in metadata, try pending checkout
      if (items.length === 0 && metadata.pending_checkout_id) {
        try {
          const pendingCheckout = await getDocument('pendingCheckouts', metadata.pending_checkout_id);
          if (pendingCheckout && pendingCheckout.items) {
            items = pendingCheckout.items;

            // Get artist shipping breakdown for payouts (artist receives their shipping fee)
            if (pendingCheckout.artistShippingBreakdown) {
              artistShippingBreakdown = pendingCheckout.artistShippingBreakdown;
            }

            // Clean up pending checkout
            try {
              await deleteDocument('pendingCheckouts', metadata.pending_checkout_id);
            } catch (cleanupErr: unknown) {
              // Non-fatal: cleanup can be retried
            }
          }
        } catch (pendingErr: unknown) {
          log.error('[Stripe Webhook] ❌ Error retrieving pending checkout:', pendingErr);
        }
      }

      // If still no items, log warning
      // If no items in metadata, try to retrieve from session line items
      if (items.length === 0 && stripeSecretKey) {
        try {
          const lineItemsResponse = await fetchWithTimeout(
            `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
            {
              headers: {
                'Authorization': `Bearer ${stripeSecretKey}`
              }
            }
          );

          if (lineItemsResponse.ok) {
            const lineItemsData = await lineItemsResponse.json();
            items = lineItemsData.data
              .filter((item: Record<string, unknown>) => item.description !== 'Processing and platform fees')
              .map((item: Record<string, unknown>, index: number) => {
                const price = item.price as Record<string, unknown> | undefined;
                const unitAmount = price?.unit_amount as number | undefined;
                return {
                  id: `stripe_item_${index}`,
                  name: item.description || 'Item',
                  price: unitAmount
                    ? unitAmount / 100
                    : ((item.amount_total as number) / 100) / ((item.quantity as number) || 1),
                  quantity: item.quantity,
                  type: 'digital' // Default type
                };
              });
          } else {
            const errorText = await lineItemsResponse.text();
            log.error('[Stripe Webhook] ❌ Line items fetch failed:', errorText);
          }
        } catch (e: unknown) {
          log.error('[Stripe Webhook] ❌ Error fetching line items:', e);
        }
      }

      // Build shipping info from Stripe shipping details
      let shipping = null;
      if (session.shipping_details) {
        const addr = session.shipping_details.address;
        shipping = {
          address1: addr.line1 || '',
          address2: addr.line2 || '',
          city: addr.city || '',
          county: addr.state || '',
          postcode: addr.postal_code || '',
          country: getCountryName(addr.country)
        };
      }

      // P0 FIX: Validate stock BEFORE creating order to prevent overselling
      // Payment is already captured at this point, so we can't reject it.
      // If stock is unavailable, flag the order for admin attention.
      let stockIssue = false;
      try {
        const stockCheck = await validateStock(items);
        if (!stockCheck.available) {
          log.error('[Stripe Webhook] Stock unavailable after payment:', stockCheck.unavailableItems);
          stockIssue = true;
        }
      } catch (stockErr: unknown) {
        log.error('[Stripe Webhook] Stock validation error (Firebase may be unreachable):', stockErr);
        // Payment is already captured - we MUST create the order regardless
        // Flag it so admin can review manually
        stockIssue = true;
      }

      // D1 DURABLE RECORD: Insert pending order before Firebase creation
      // If Firebase fails after payment, this record ensures the order is not lost
      const db = env?.DB;
      if (db) {
        try {
          await db.prepare(`
            INSERT INTO pending_orders (stripe_session_id, customer_email, amount_total, currency, items, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
          `).bind(
            session.id,
            metadata.customer_email || session.customer_email || '',
            session.amount_total || 0,
            session.currency || 'gbp',
            metadata.items_json || JSON.stringify(items)
          ).run();
          // D1 pending record created
        } catch (d1Err: unknown) {
          // D1 write failure must not block order creation — log and continue
          log.error('[Stripe Webhook] D1 pending_orders insert failed (non-blocking):', d1Err);
        }
      }

      // Create order using shared utility
      const result = await createOrder({
        orderData: {
          customer: {
            email: metadata.customer_email,
            firstName: metadata.customer_firstName || 'Customer',
            lastName: metadata.customer_lastName || '',
            phone: metadata.customer_phone || '',
            userId: metadata.customer_userId || undefined
          },
          shipping,
          items,
          totals: {
            subtotal: parseFloat(metadata.subtotal) || (session.amount_total / 100),
            shipping: parseFloat(metadata.shipping) || 0,
            serviceFees: parseFloat(metadata.serviceFees) || 0,
            total: session.amount_total / 100,
            appliedCredit: parseFloat(metadata.appliedCredit) || 0,
            amountPaid: session.amount_total / 100
          },
          hasPhysicalItems: metadata.hasPhysicalItems === 'true',
          paymentMethod: 'stripe',
          paymentIntentId: session.payment_intent,
          ...(stockIssue && { stockIssue: true, stockIssueNote: 'Stock was unavailable when payment completed. Requires admin review for potential refund.' })
        },
        env
      });

      // createOrder returned

      if (!result.success) {
        log.error('[Stripe Webhook] ❌ ORDER CREATION FAILED');
        log.error('[Stripe Webhook] Error:', result.error);

        logStripeEvent(event.type, event.id, false, {
          message: 'Order creation failed',
          error: result.error || 'Unknown error',
          processingTimeMs: Date.now() - startTime
        }).catch(e => log.error('[Stripe Webhook] Log error:', e));

        return jsonResponse({
          error: result.error || 'Failed to create order'
        }, 500);
      }

      log.info('[Stripe Webhook] Order created:', result.orderNumber, result.orderId);

      // D1: Mark pending order as completed with Firebase order ID
      if (db) {
        try {
          await db.prepare(`
            UPDATE pending_orders
            SET status = 'completed', firebase_order_id = ?, updated_at = datetime('now')
            WHERE stripe_session_id = ?
          `).bind(result.orderId || '', session.id).run();
          // D1 pending record updated
        } catch (d1Err: unknown) {
          log.error('[Stripe Webhook] D1 pending_orders update failed (non-blocking):', d1Err);
        }
      }

      // Convert stock reservation
      const reservationId = metadata.reservation_id;
      if (reservationId) {
        try {
          const { convertReservation } = await import('../../../lib/order-utils');
          await convertReservation(reservationId);
          // Reservation converted
        } catch (err: unknown) {
          log.error('[Stripe Webhook] Failed to convert reservation:', err);
        }
      }

      // Record to sales ledger (source of truth for analytics)
      // Look up seller info for ALL items so multi-seller orders are handled correctly
      try {
        const shippingAmount = parseFloat(metadata.shipping) || 0;
        const serviceFees = parseFloat(metadata.serviceFees) || 0;
        const freshWaxFee = parseFloat(metadata.freshWaxFee) || 0;
        // Estimate Stripe fee: 1.5% + £0.20 for UK cards (average)
        const stripeFee = serviceFees > 0 ? (serviceFees - freshWaxFee) : ((session.amount_total / 100) * 0.015 + 0.20);

        // Enrich items with seller info from release/product lookup
        const enrichedItems = await Promise.all(items.map(async (item: Record<string, unknown>) => {
          const releaseId = item.releaseId || item.productId || item.id;
          let submitterId = null;
          let submitterEmail = null;
          let artistName = item.artist || item.artistName || null;

          // Look up release to get submitter info
          if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
            try {
              const release = await getDocument('releases', releaseId);
              if (release) {
                submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
                // Email field - release stores it as 'email', not 'submitterEmail'
                submitterEmail = release.email || release.submitterEmail || release.metadata?.email || null;
                artistName = release.artistName || release.artist || artistName;

                // seller lookup done
              }
            } catch (lookupErr: unknown) {
              log.error(`[Stripe Webhook] Failed to lookup release ${releaseId}:`, lookupErr);
            }
          }

          // For merch items, look up the merch document for seller info
          if (item.type === 'merch' && item.productId) {
            try {
              const merch = await getDocument('merch', item.productId);
              if (merch) {
                // Check supplierId first (set by assign-seller), then sellerId, then fallbacks
                submitterId = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy || null;
                submitterEmail = merch.email || merch.sellerEmail || null;
                artistName = merch.sellerName || merch.supplierName || merch.brandName || artistName;

                // If no email on product, look up seller in users/artists collection
                if (!submitterEmail && submitterId) {
                  try {
                    const userData = await getDocument('users', submitterId);
                    if (userData?.email) {
                      submitterEmail = userData.email;
                    } else {
                      const artistData = await getDocument('artists', submitterId);
                      if (artistData?.email) {
                        submitterEmail = artistData.email;
                      }
                    }
                  } catch (e: unknown) {
                    // Ignore lookup errors
                  }
                }

                // merch seller lookup done
              }
            } catch (lookupErr: unknown) {
              log.error(`[Stripe Webhook] Failed to lookup merch ${item.productId}:`, lookupErr);
            }
          }

          return {
            ...item,
            submitterId,
            submitterEmail,
            artistName
          };
        }));

        // Use multi-seller recording to create per-seller ledger entries
        // Dual-write: D1 (primary) + Firebase (backup)
        await recordMultiSellerSale({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          customerId: metadata.customer_userId || null,
          customerEmail: metadata.customer_email,
          customerName: metadata.customer_displayName || metadata.customer_firstName || null,
          grossTotal: session.amount_total / 100,
          shipping: shippingAmount,
          stripeFee: Math.round(stripeFee * 100) / 100,
          freshWaxFee,
          paymentMethod: 'stripe',
          paymentId: session.payment_intent as string,
          hasPhysical: metadata.hasPhysicalItems === 'true',
          hasDigital: enrichedItems.some((i: Record<string, unknown>) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
          items: enrichedItems,
          db: env?.DB  // D1 database for dual-write
        });
        // Sale recorded to ledger
      } catch (ledgerErr: unknown) {
        log.error('[Stripe Webhook] ⚠️ Failed to record to ledger:', ledgerErr);
        // Don't fail the order, ledger is supplementary
      }

      // Process artist payments via Stripe Connect
      if (result.orderId && stripeSecretKey) {
        // Calculate total item count for fair fee splitting across all item types
        const totalItemCount = items.length;

        // Calculate order subtotal for processing fee calculation
        const orderSubtotal = items.reduce((sum: number, item: Record<string, unknown>) => {
          return sum + ((item.price || 0) * (item.quantity || 1));
        }, 0);

        // Process artist payments
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount,
          orderSubtotal,
          artistShippingBreakdown, // Include shipping fees for artists who ship vinyl
          stripeSecretKey,
          env
        });

        // Process supplier payments for merch items
        // Process supplier payments
        await processSupplierPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });

        // Process vinyl crate seller payments
        // Process vinyl crate seller payments
        await processVinylCrateSellerPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      }

      // Deduct applied credit from user's balance (kept for backwards compatibility
      // with in-flight orders; new orders use complete-free-order for credit)
      const appliedCredit = parseFloat(metadata.appliedCredit) || 0;
      const userId = metadata.customer_userId;
      if (appliedCredit > 0 && userId) {
        // Deduct applied credit
        try {
          const creditData = await getDocument('userCredits', userId);
          if (creditData && creditData.balance >= appliedCredit) {
            const now = new Date().toISOString();

            // Atomically decrement balance to prevent race conditions
            await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

            // Create transaction record
            const newBalance = creditData.balance - appliedCredit;
            const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const transaction = {
              id: transactionId,
              type: 'purchase',
              amount: -appliedCredit,
              description: `Applied to order ${result.orderNumber || result.orderId}`,
              orderId: result.orderId,
              orderNumber: result.orderNumber,
              createdAt: now,
              balanceAfter: newBalance
            };

            // Atomic arrayUnion prevents lost transactions under concurrent writes
            await arrayUnion('userCredits', userId, 'transactions', [transaction], {
              lastUpdated: now
            });

            // Also update user document atomically
            await atomicIncrement('users', userId, { creditBalance: -appliedCredit });
            await updateDocument('users', userId, { creditUpdatedAt: now });

            // Credit deducted
          } else {
            log.warn('[Stripe Webhook] Insufficient credit balance for deduction');
          }
        } catch (creditErr: unknown) {
          log.error('[Stripe Webhook] Failed to deduct credit:', creditErr);
          // Don't fail the order, just log the error
        }
      }

      // Log successful order
      logStripeEvent(event.type, event.id, true, {
        message: `Order ${result.orderNumber} created successfully`,
        metadata: { orderId: result.orderId, orderNumber: result.orderNumber, amount: session.amount_total / 100 },
        processingTimeMs: Date.now() - startTime
      }).catch(e => log.error('[Stripe Webhook] Log error:', e)); // Don't let logging failures affect response

      // Invalidate KV + in-memory caches so stale stock data is not served
      const hasReleaseItems = items.some((i: Record<string, unknown>) =>
        i.type === 'digital' || i.type === 'release' || i.type === 'track' || i.type === 'vinyl'
      );
      const hasMerchItems = items.some((i: Record<string, unknown>) => i.type === 'merch');

      if (hasReleaseItems) {
        invalidateReleasesCache();
        await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => { /* KV cache invalidation — non-critical */ });
        await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => { /* KV cache invalidation — non-critical */ });
      }
      if (hasMerchItems) {
        clearAllMerchCache();
        await kvDelete('live-merch-v2:all', CACHE_CONFIG.MERCH).catch(() => { /* KV cache invalidation — non-critical */ });
      }
    }

    // Handle payment_intent.succeeded (backup for session complete)
    if (event.type === 'payment_intent.succeeded') {
      // Order should already be created by checkout.session.completed
    }

    // Handle subscription renewal (invoice.payment_succeeded for recurring payments)
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      // Invoice payment for subscription

      // Only process subscription renewals, not initial payments
      if (invoice.billing_reason === 'subscription_cycle' && invoice.subscription) {
        // Process Plus subscription renewal

        // IDEMPOTENCY CHECK: Skip if this invoice renewal was already processed
        // Use the invoice ID as a deduplication key by checking lastRenewalInvoiceId on the user
        // This prevents duplicate expiry extensions and renewal emails on Stripe retries

        // Get subscription details from Stripe
        const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
        if (stripeSecretKey) {
          try {
            const subResponse = await fetchWithTimeout(
              `https://api.stripe.com/v1/subscriptions/${invoice.subscription}`,
              {
                headers: { 'Authorization': `Bearer ${stripeSecretKey}` }
              }
            );
            if (!subResponse.ok) {
              log.error(`[Stripe Webhook] Failed to fetch subscription: ${subResponse.status}`);
              return jsonResponse({ received: true, error: 'Failed to fetch subscription' });
            }
            const subscription = await subResponse.json();

            if (subscription.metadata?.userId) {
              const userId = subscription.metadata.userId;
              const email = invoice.customer_email || subscription.metadata.email;

              // Calculate new expiry (extend by 1 year from current expiry or now)
              const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
              const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

              // Get current user to check existing expiry
              const userResponse = await fetchWithTimeout(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?key=${FIREBASE_API_KEY}`
              );
              if (!userResponse.ok) {
                log.error(`[Stripe Webhook] Failed to fetch user: ${userResponse.status}`);
                return jsonResponse({ received: true, error: 'Failed to fetch user' });
              }
              const userData = await userResponse.json();

              // IDEMPOTENCY CHECK: Skip if this exact invoice renewal was already applied
              const lastRenewalInvoice = userData.fields?.subscription?.mapValue?.fields?.lastRenewalInvoiceId?.stringValue;
              if (lastRenewalInvoice === invoice.id) {
                // Renewal already processed for this invoice
                return jsonResponse({ received: true, message: 'Renewal already processed' });
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
              const updateData = {
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
                      }
                    }
                  }
                }
              };

              // Preserve existing fields
              if (userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue) {
                updateData.fields.subscription.mapValue.fields.subscribedAt =
                  userData.fields.subscription.mapValue.fields.subscribedAt;
              }
              if (userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue) {
                updateData.fields.subscription.mapValue.fields.plusId =
                  userData.fields.subscription.mapValue.fields.plusId;
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
                  const origin = new URL(request.url).origin;
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
        }
      }
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
      log.info('[Stripe Webhook] Checkout session expired:', session.id);

      const reservationId = session.metadata?.reservation_id;
      if (reservationId) {
        try {
          const { releaseReservation } = await import('../../../lib/order-utils');
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
          try { items = JSON.parse(itemsMeta); } catch (e: unknown) { /* invalid JSON */ }

          if (items.length > 0) {
            // Check email opt-out (forward-compatible)
            let optedOut = false;
            const userId = session.metadata?.userId || session.metadata?.customer_id;
            if (userId) {
              try {
                const userDoc = await getDocument('customers', userId, env);
                if (userDoc && (userDoc as Record<string, unknown>).emailOptOut) {
                  optedOut = true;
                }
              } catch (e: unknown) { /* user not found, proceed */ }
            }

            if (!optedOut) {
              // Rate limit: max 1 per email per 24h
              const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
              const recentEmails = await queryCollection('abandonedCartEmails', env, [
                { field: 'email', op: 'EQUAL', value: customerEmail },
                { field: 'sentAt', op: 'GREATER_THAN_OR_EQUAL', value: oneDayAgo }
              ]);

              if (!recentEmails || recentEmails.length === 0) {
                const { sendAbandonedCartEmail } = await import('../../../lib/abandoned-cart-email');
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
                }, env);

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
