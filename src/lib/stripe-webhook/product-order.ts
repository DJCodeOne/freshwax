// src/lib/stripe-webhook/product-order.ts
// Product order and gift card handlers extracted from webhook.ts

import Stripe from 'stripe';
import { createOrder, validateStock } from '../order-utils';
import { getDocument, queryCollection, deleteDocument, addDocument, updateDocument, atomicIncrement, arrayUnion, invalidateReleasesCache, clearAllMerchCache } from '../firebase-rest';
import { kvDelete, CACHE_CONFIG, invalidateReleasesKVCache } from '../kv-cache';
import { logStripeEvent } from '../webhook-logger';
import { createGiftCardAfterPayment } from '../giftcard';
import { recordMultiSellerSale } from '../sales-ledger';
import { fetchWithTimeout, createLogger, errorResponse } from '../api-utils';
import { processArtistPayments, processSupplierPayments, getCountryName } from './payments';
import { processVinylCrateSellerPayments } from './vinyl-crate-payments';

const log = createLogger('stripe-webhook-product-order');

/** Context passed from the main webhook handler */
export interface ProductOrderContext {
  env: Record<string, unknown>;
  stripeSecretKey: string;
  requestUrl: string;
  startTime: number;
  eventType: string;
  eventId: string;
}

/**
 * Handle gift card purchases (checkout.session.completed with metadata.type === 'giftcard').
 * Creates the gift card via createGiftCardAfterPayment.
 */
export async function handleGiftCardPurchase(
  session: Stripe.Checkout.Session,
  ctx: ProductOrderContext
): Promise<{ received: true; giftCard?: boolean; code?: string; message?: string; error?: string }> {
  const metadata = session.metadata || {};
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
        return {
          received: true,
          message: 'Gift card already created',
          code: existingCards[0].code as string
        };
      }
    } catch (checkErr: unknown) {
      log.error('[Stripe Webhook] Gift card idempotency check failed:', checkErr);
      throw new GiftCardIdempotencyError('Gift card idempotency check failed — retry later');
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
    log.error('[Stripe Webhook] Failed to create gift card:', result.error);
  }

  return {
    received: true,
    giftCard: result.success,
    code: result.giftCard?.code
  };
}

/**
 * Handle product order processing (checkout.session.completed for standard orders).
 * Creates order, processes payments, deducts credits, invalidates caches.
 */
export async function handleProductOrder(
  session: Stripe.Checkout.Session,
  ctx: ProductOrderContext
): Promise<{ received: true; orderId?: string; orderNumber?: string; message?: string; error?: string } | null> {
  const { env, stripeSecretKey, requestUrl, startTime, eventType, eventId } = ctx;

  // Extract order data from metadata
  const metadata = session.metadata || {};
  log.debug('[Stripe Webhook] Metadata keys:', Object.keys(metadata).join(', '));

  // Skip if no customer email (not a valid order)
  if (!metadata.customer_email) {
    log.debug('[Stripe Webhook] No customer email in metadata - skipping');
    log.debug('[Stripe Webhook] Available metadata keys:', Object.keys(metadata).join(', '));
    return { received: true };
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
        return {
          received: true,
          message: 'Order already exists',
          orderId: existingOrders[0].id as string
        };
      }
      // No existing order - proceed with creation
    } catch (idempotencyErr: unknown) {
      log.error('[Stripe Webhook] Idempotency check failed (Firebase unreachable):', idempotencyErr);
      // Return error so Stripe retries later when Firebase is back up
      // This prevents duplicate orders when we can't verify idempotency
      throw new OrderIdempotencyError('Temporary error checking order status. Will retry.');
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
      log.error('[Stripe Webhook] Error parsing items_json:', e);
      log.error('[Stripe Webhook] items_json value:', metadata.items_json?.substring(0, 200));
    }
  }

  // If no items in metadata, try pending checkout
  if (items.length === 0 && metadata.pending_checkout_id) {
    try {
      const pendingCheckout = await getDocument('pendingCheckouts', metadata.pending_checkout_id);
      if (pendingCheckout && pendingCheckout.items) {
        items = pendingCheckout.items as Record<string, unknown>[];

        // Get artist shipping breakdown for payouts (artist receives their shipping fee)
        if (pendingCheckout.artistShippingBreakdown) {
          artistShippingBreakdown = pendingCheckout.artistShippingBreakdown as Record<string, { artistId: string; artistName: string; amount: number }>;
        }

        // Clean up pending checkout
        try {
          await deleteDocument('pendingCheckouts', metadata.pending_checkout_id);
        } catch (cleanupErr: unknown) {
          // Non-fatal: cleanup can be retried
        }
      }
    } catch (pendingErr: unknown) {
      log.error('[Stripe Webhook] Error retrieving pending checkout:', pendingErr);
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
        log.error('[Stripe Webhook] Line items fetch failed:', errorText);
      }
    } catch (e: unknown) {
      log.error('[Stripe Webhook] Error fetching line items:', e);
    }
  }

  // Build shipping info from Stripe shipping details
  let shipping = null;
  if (session.shipping_details) {
    const addr = session.shipping_details.address;
    shipping = {
      address1: addr?.line1 || '',
      address2: addr?.line2 || '',
      city: addr?.city || '',
      county: addr?.state || '',
      postcode: addr?.postal_code || '',
      country: getCountryName(addr?.country || '')
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
  const db = env?.DB as D1Database | undefined;
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
        subtotal: parseFloat(metadata.subtotal) || (session.amount_total! / 100),
        shipping: parseFloat(metadata.shipping) || 0,
        serviceFees: parseFloat(metadata.serviceFees) || 0,
        total: session.amount_total! / 100,
        appliedCredit: parseFloat(metadata.appliedCredit) || 0,
        amountPaid: session.amount_total! / 100
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
    log.error('[Stripe Webhook] ORDER CREATION FAILED');
    log.error('[Stripe Webhook] Error:', result.error);

    logStripeEvent(eventType, eventId, false, {
      message: 'Order creation failed',
      error: result.error || 'Unknown error',
      processingTimeMs: Date.now() - startTime
    }).catch(e => log.error('[Stripe Webhook] Log error:', e));

    return {
      received: true,
      error: result.error || 'Failed to create order'
    };
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
      const { convertReservation } = await import('../order-utils');
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
    const stripeFee = serviceFees > 0 ? (serviceFees - freshWaxFee) : ((session.amount_total! / 100) * 0.015 + 0.20);

    // Enrich items with seller info from release/product lookup
    // Use Promise.allSettled so a single failed enrichment doesn't block the sales ledger
    const enrichmentResults = await Promise.allSettled(items.map(async (item: Record<string, unknown>) => {
      const releaseId = item.releaseId || item.productId || item.id;
      let submitterId = null;
      let submitterEmail = null;
      let artistName = item.artist || item.artistName || null;

      // Look up release to get submitter info
      if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
        try {
          const release = await getDocument('releases', releaseId as string);
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
          const merch = await getDocument('merch', item.productId as string);
          if (merch) {
            // Check supplierId first (set by assign-seller), then sellerId, then fallbacks
            submitterId = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy || null;
            submitterEmail = merch.email || merch.sellerEmail || null;
            artistName = merch.sellerName || merch.supplierName || merch.brandName || artistName;

            // If no email on product, look up seller in users/artists collection
            if (!submitterEmail && submitterId) {
              try {
                const userData = await getDocument('users', submitterId as string);
                if (userData?.email) {
                  submitterEmail = userData.email;
                } else {
                  const artistData = await getDocument('artists', submitterId as string);
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
    const enrichedItems = enrichmentResults.map((result, i) =>
      result.status === 'fulfilled' ? result.value : { ...items[i], submitterId: null, submitterEmail: null, artistName: items[i].artist || items[i].artistName || null }
    );

    // Use multi-seller recording to create per-seller ledger entries
    // Dual-write: D1 (primary) + Firebase (backup)
    await recordMultiSellerSale({
      orderId: result.orderId,
      orderNumber: result.orderNumber || '',
      customerId: metadata.customer_userId || null,
      customerEmail: metadata.customer_email,
      customerName: metadata.customer_displayName || metadata.customer_firstName || null,
      grossTotal: session.amount_total! / 100,
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
    log.error('[Stripe Webhook] Failed to record to ledger:', ledgerErr);
    // Don't fail the order, ledger is supplementary
  }

  // Process artist payments via Stripe Connect
  if (result.orderId && stripeSecretKey) {
    // Calculate total item count for fair fee splitting across all item types
    const totalItemCount = items.length;

    // Calculate order subtotal for processing fee calculation
    const orderSubtotal = items.reduce((sum: number, item: Record<string, unknown>) => {
      return sum + (((item.price as number) || 0) * ((item.quantity as number) || 1));
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
      if (creditData && (creditData.balance as number) >= appliedCredit) {
        const now = new Date().toISOString();

        // Atomically decrement balance to prevent race conditions
        await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

        // Create transaction record
        const newBalance = (creditData.balance as number) - appliedCredit;
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
  logStripeEvent(eventType, eventId, true, {
    message: `Order ${result.orderNumber} created successfully`,
    metadata: { orderId: result.orderId, orderNumber: result.orderNumber, amount: session.amount_total! / 100 },
    processingTimeMs: Date.now() - startTime
  }).catch(e => log.error('[Stripe Webhook] Log error:', e)); // Don't let logging failures affect response

  // Invalidate KV + in-memory caches so stale stock data is not served
  const hasReleaseItems = items.some((i: Record<string, unknown>) =>
    i.type === 'digital' || i.type === 'release' || i.type === 'track' || i.type === 'vinyl'
  );
  const hasMerchItems = items.some((i: Record<string, unknown>) => i.type === 'merch');

  if (hasReleaseItems) {
    invalidateReleasesCache();
    await invalidateReleasesKVCache();
  }
  if (hasMerchItems) {
    clearAllMerchCache();
    await kvDelete('live-merch-v2:all', CACHE_CONFIG.MERCH).catch(() => { /* KV cache invalidation — non-critical */ });
  }

  return null; // Signal success — caller returns jsonResponse({ received: true })
}

/**
 * Custom error class for order idempotency check failures.
 * The main webhook handler should return 500 when this is thrown so Stripe retries.
 */
export class OrderIdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderIdempotencyError';
  }
}

/**
 * Custom error class for gift card idempotency check failures.
 * The main webhook handler should return 500 (via errorResponse) when this is thrown.
 */
export class GiftCardIdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiftCardIdempotencyError';
  }
}
