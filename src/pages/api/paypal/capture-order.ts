// src/pages/api/paypal/capture-order.ts
// Captures a PayPal order after customer approval and creates the order in Firebase

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createOrder, validateStock } from '../../../lib/order-utils';
import { getDocument, deleteDocument, addDocument, updateDocument, atomicIncrement, arrayUnion, queryCollection } from '../../../lib/firebase-rest';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';
import { createLogger, fetchWithTimeout, errorResponse, successResponse, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[paypal-capture]');
import { getPayPalBaseUrl, getPayPalAccessToken } from '../../../lib/paypal-auth';

// Zod schema for PayPal capture request
const PayPalCaptureSchema = z.object({
  paypalOrderId: z.string().min(1, 'PayPal order ID required'),
  orderData: z.record(z.unknown()).optional(),
  idToken: z.string().optional(),
}).strip();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-capture:${clientIdReq}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      return ApiErrors.serverError('PayPal not configured');
    }

    const rawBody = await request.json();

    const parseResult = PayPalCaptureSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { paypalOrderId, orderData: clientOrderData, idToken } = parseResult.data;

    // Capture PayPal order

    // IDEMPOTENCY CHECK: Check if order with this PayPal ID already exists
    // Uses throwOnError=true so Firebase outages return 503 instead of creating duplicates
    try {
      const existingOrders = await queryCollection('orders', {
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
        limit: 1
      }, true);
      if (existingOrders && existingOrders.length > 0) {
        const existingOrder = existingOrders[0];
        // Order already exists (idempotent)
        return successResponse({ orderId: existingOrder.id,
          orderNumber: existingOrder.orderNumber,
          message: 'Order already processed' });
      }
    } catch (idempotencyErr: unknown) {
      log.error('[PayPal] Idempotency check failed (Firebase unreachable):', idempotencyErr);
      // Don't proceed - we can't verify if this order was already processed
      // Customer can retry when Firebase is back
      return errorResponse('Unable to verify order status. Please try again in a moment.', 503);
    }

    // SECURITY: Retrieve order data from Firebase - never trust client-submitted data
    let orderData: Record<string, unknown>;
    let usedServerData = false;
    let paypalReservationId: string | null = null;

    try {
      const pendingOrder = await getDocument('pendingPayPalOrders', paypalOrderId);
      if (pendingOrder) {
        // Retrieved server-side order data
        paypalReservationId = pendingOrder.reservationId || null;
        orderData = {
          customer: pendingOrder.customer,
          shipping: pendingOrder.shipping,
          items: pendingOrder.items,
          totals: pendingOrder.totals,
          hasPhysicalItems: pendingOrder.hasPhysicalItems,
          appliedCredit: pendingOrder.appliedCredit || 0
        };
        usedServerData = true;

        // Clean up pending order
        try {
          await deleteDocument('pendingPayPalOrders', paypalOrderId);
          // Cleaned up pending order
        } catch (delErr: unknown) {
          log.warn('[PayPal] Could not delete pending order:', delErr);
        }
      } else {
        // SECURITY: Reject if no server-side order exists.
        // The pending order is created during create-order and must exist for a legitimate flow.
        log.error('[PayPal] SECURITY: No pending order found for', paypalOrderId, '- rejecting capture');
        return ApiErrors.badRequest('Order session expired or invalid. Please try again.');
      }
    } catch (fetchErr: unknown) {
      log.error('[PayPal] Error fetching pending order:', fetchErr);
      return ApiErrors.serverError('Could not verify order data. Please try again.');
    }

    // P0 FIX: Validate stock BEFORE capturing payment to prevent overselling
    // Unlike Stripe webhooks, PayPal capture hasn't happened yet so we can reject
    try {
      const stockCheck = await validateStock(orderData.items || []);
      if (!stockCheck.available) {
        log.error('[PayPal] Stock unavailable before capture:', stockCheck.unavailableItems);
        return ApiErrors.conflict('Some items are no longer available');
      }
    } catch (stockErr: unknown) {
      log.error('[PayPal] Stock validation error (Firebase may be unreachable):', stockErr);
      // Fail closed: if we can't verify stock (Firebase down), don't capture payment
      // Payment hasn't been captured yet so customer isn't charged - they can retry
      return errorResponse('Unable to verify stock availability. Please try again in a moment.', 503);
    }

    // Get access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Capture the PayPal order
    const captureResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_${paypalOrderId}_${Date.now()}`
      }
    }, 10000);

    if (!captureResponse.ok) {
      const error = await captureResponse.text();
      log.error('[PayPal] Capture error:', error);
      return ApiErrors.serverError('Failed to capture PayPal payment');
    }

    const captureResult = await captureResponse.json();
    // Capture result received

    // Verify payment was captured successfully
    if (captureResult.status !== 'COMPLETED') {
      log.error('[PayPal] Payment not completed:', captureResult.status);
      return ApiErrors.badRequest('Payment was not completed. Please try again.');
    }

    // Get capture details
    const capture = captureResult.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id;
    const capturedAmount = parseFloat(capture?.amount?.value || '0');

    // Payment captured successfully

    // Amount verification: compare captured amount against expected total
    // Don't block on mismatch -- the customer already paid. Flag for admin review instead.
    const expectedTotal = parseFloat(orderData.totals?.total?.toFixed(2) || '0');
    let amountMismatch = false;
    if (Math.abs(capturedAmount - expectedTotal) > 0.01) {
      amountMismatch = true;
      log.error('[PayPal] AMOUNT MISMATCH! Captured:', capturedAmount, 'Expected:', expectedTotal, 'PayPal Order:', paypalOrderId);
      // Flag for admin review via Firebase document
      try {
        await addDocument('flaggedOrders', {
          paypalOrderId,
          captureId,
          capturedAmount,
          expectedTotal,
          difference: Math.round((capturedAmount - expectedTotal) * 100) / 100,
          customerEmail: orderData.customer?.email || '',
          reason: 'amount_mismatch',
          status: 'needs_review',
          createdAt: new Date().toISOString()
        });
        log.warn('[PayPal] Order flagged for admin review due to amount mismatch');
      } catch (flagErr: unknown) {
        log.error('[PayPal] Failed to create flaggedOrders doc:', flagErr);
      }
    }

    // Get applied credit from order data
    const appliedCredit = orderData.appliedCredit || 0;

    // D1 DURABLE RECORD: Insert pending order before Firebase creation
    // If Firebase fails after payment, this record ensures the order is not lost
    // Reuses the same pending_orders table as the Stripe webhook for admin visibility
    const db = env?.DB;
    if (db) {
      try {
        await db.prepare(`
          INSERT INTO pending_orders (stripe_session_id, customer_email, amount_total, currency, items, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
        `).bind(
          `paypal:${paypalOrderId}`,
          orderData.customer?.email || '',
          Math.round(capturedAmount * 100),
          'gbp',
          JSON.stringify(orderData.items || [])
        ).run();
        // D1 pending_orders row inserted
      } catch (d1Err: unknown) {
        // D1 write failure must not block order creation -- log and continue
        log.error('[PayPal] D1 pending_orders insert failed (non-blocking):', d1Err);
      }
    }

    // Create order in Firebase using shared utility
    // Wrap in try/catch to handle race condition: if a concurrent request already
    // created the order between our idempotency check and now, return the existing one.
    let result: { success: boolean; orderId?: string; orderNumber?: string; error?: string };
    try {
      result = await createOrder({
        orderData: {
          customer: orderData.customer,
          shipping: orderData.shipping,
          items: orderData.items,
          totals: {
            ...orderData.totals,
            appliedCredit,
            amountPaid: capturedAmount,
            ...(amountMismatch ? { amountMismatch: true, expectedTotal, capturedAmount } : {})
          },
          hasPhysicalItems: orderData.hasPhysicalItems,
          paymentMethod: 'paypal',
          paypalOrderId: paypalOrderId,
          ...(amountMismatch ? { flagged: true, flagReason: 'amount_mismatch' } : {})
        },
        env,
        idToken
      });
    } catch (createErr: unknown) {
      log.error('[PayPal] Order creation threw:', createErr);
      result = { success: false, error: createErr instanceof Error ? createErr.message : 'Order creation failed' };
    }

    // After creation attempt, re-check for existing order to handle race condition.
    // If two requests passed the initial idempotency check simultaneously, one will
    // have created the order by now. Return the existing order instead of duplicating.
    if (result.success) {
      // D1: Mark pending order as completed with Firebase order ID
      if (db) {
        try {
          await db.prepare(`
            UPDATE pending_orders
            SET status = 'completed', firebase_order_id = ?, updated_at = datetime('now')
            WHERE stripe_session_id = ?
          `).bind(result.orderId || '', `paypal:${paypalOrderId}`).run();
          // D1 pending_orders updated to completed
        } catch (d1Err: unknown) {
          log.error('[PayPal] D1 pending_orders update failed (non-blocking):', d1Err);
        }
      }

      try {
        const duplicateCheck = await queryCollection('orders', {
          filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
          limit: 2
        });
        if (duplicateCheck && duplicateCheck.length > 1) {
          // Race condition detected: multiple orders for same paypalOrderId
          // Return the first one (earliest created) and log the duplicate
          const firstOrder = duplicateCheck.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
            ((a.createdAt as string) || '').localeCompare((b.createdAt as string) || '')
          )[0];
          log.warn('[PayPal] RACE CONDITION: Duplicate orders detected for paypalOrderId:', paypalOrderId,
            'Returning first order:', firstOrder.orderNumber);
          return successResponse({ orderId: firstOrder.id,
            orderNumber: firstOrder.orderNumber,
            paypalOrderId: paypalOrderId,
            message: 'Order already processed' });
        }
      } catch (dupCheckErr: unknown) {
        log.warn('[PayPal] Post-creation duplicate check failed:', dupCheckErr);
        // Non-fatal: continue with the order we created
      }
    }

    if (!result.success) {
      // D1: Mark pending order as failed so admin can see the failure reason
      if (db) {
        try {
          await db.prepare(`
            UPDATE pending_orders
            SET status = 'failed', updated_at = datetime('now')
            WHERE stripe_session_id = ?
          `).bind(`paypal:${paypalOrderId}`).run();
          // D1 pending_orders marked as failed
        } catch (d1Err: unknown) {
          log.error('[PayPal] D1 pending_orders failure update failed:', d1Err);
        }
      }

      // Before returning an error, check one more time if a concurrent request created the order
      try {
        const existingOrders = await queryCollection('orders', {
          filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: paypalOrderId }],
          limit: 1
        });
        if (existingOrders && existingOrders.length > 0) {
          const existingOrder = existingOrders[0];
          // Order creation failed but existing order found (race condition)
          return successResponse({ orderId: existingOrder.id,
            orderNumber: existingOrder.orderNumber,
            paypalOrderId: paypalOrderId,
            message: 'Order already processed' });
        }
      } catch (fallbackErr: unknown) {
        log.warn('[PayPal] Fallback duplicate check failed:', fallbackErr);
      }

      log.error('[PayPal] ORPHANED PAYMENT - Order creation failed after capture.',
        'PayPal Order:', paypalOrderId, 'Capture:', captureId, 'Amount:', capturedAmount,
        'Customer:', orderData.customer?.email, 'Error:', result.error);
      return ApiErrors.serverError('Payment was captured but order creation failed. Your payment is safe — our team has been notified and will process your order shortly.');
    }

    log.info('[PayPal] Order created:', result.orderNumber);

    // Convert stock reservation (payment succeeded)
    if (paypalReservationId) {
      try {
        const { convertReservation } = await import('../../../lib/order-utils');
        await convertReservation(paypalReservationId);
        // Reservation converted
      } catch (err: unknown) {
        log.error('[PayPal] Failed to convert reservation:', err);
      }
    }

    // Record to sales ledger (source of truth for analytics)
    // Look up seller info for ALL items so multi-seller orders are handled correctly
    try {
      const freshWaxFee = orderData.totals?.freshWaxFee || 0;
      // PayPal fee: approximately 2.9% + £0.30
      const paypalFee = (capturedAmount * 0.029) + 0.30;

      // Batch-fetch all releases and merch products in parallel to avoid N+1
      const itemsList = (orderData.items as Record<string, unknown>[]) || [];

      // Collect unique release IDs
      const ledgerReleaseIds = new Set<string>();
      for (const item of itemsList) {
        const releaseId = item.releaseId || item.productId || item.id;
        if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
          ledgerReleaseIds.add(releaseId as string);
        }
      }

      // Collect unique merch product IDs
      const ledgerMerchIds = new Set<string>();
      for (const item of itemsList) {
        if (item.type === 'merch' && item.productId) {
          ledgerMerchIds.add(item.productId as string);
        }
      }

      // Batch-fetch releases and merch in parallel
      // Use Promise.allSettled so a failed batch doesn't block the entire ledger enrichment
      const [ledgerReleaseResult, ledgerMerchResult] = await Promise.allSettled([
        Promise.all([...ledgerReleaseIds].map(async (id) => {
          const doc = await getDocument('releases', id).catch(() => null);
          return [id, doc] as const;
        })),
        Promise.all([...ledgerMerchIds].map(async (id) => {
          const doc = await getDocument('merch', id).catch(() => null);
          return [id, doc] as const;
        }))
      ]);
      const ledgerReleaseEntries = ledgerReleaseResult.status === 'fulfilled' ? ledgerReleaseResult.value : [];
      const ledgerMerchEntries = ledgerMerchResult.status === 'fulfilled' ? ledgerMerchResult.value : [];
      if (ledgerReleaseResult.status === 'rejected') {
        log.error('[PayPal] Ledger release batch fetch failed', { error: ledgerReleaseResult.reason });
      }
      if (ledgerMerchResult.status === 'rejected') {
        log.error('[PayPal] Ledger merch batch fetch failed', { error: ledgerMerchResult.reason });
      }
      const ledgerReleaseMap = new Map(ledgerReleaseEntries.filter(([, doc]) => doc));
      const ledgerMerchMap = new Map(ledgerMerchEntries.filter(([, doc]) => doc));

      // Collect submitterIds from merch items that need user/artist email lookup
      const submitterLookupIds = new Set<string>();
      for (const item of itemsList) {
        if (item.type === 'merch' && item.productId) {
          const merch = ledgerMerchMap.get(item.productId as string);
          if (merch) {
            const sid = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy;
            const hasEmail = merch.email || merch.sellerEmail;
            if (!hasEmail && sid) submitterLookupIds.add(sid as string);
          }
        }
      }

      // Batch-fetch users and artists for submitter email resolution
      // Use Promise.allSettled so a failed batch doesn't block the entire ledger enrichment
      const [submitterUserResult, submitterArtistResult] = await Promise.allSettled([
        Promise.all([...submitterLookupIds].map(async (id) => {
          const doc = await getDocument('users', id).catch(() => null);
          return [id, doc] as const;
        })),
        Promise.all([...submitterLookupIds].map(async (id) => {
          const doc = await getDocument('artists', id).catch(() => null);
          return [id, doc] as const;
        }))
      ]);
      const submitterUserEntries = submitterUserResult.status === 'fulfilled' ? submitterUserResult.value : [];
      const submitterArtistEntries = submitterArtistResult.status === 'fulfilled' ? submitterArtistResult.value : [];
      if (submitterUserResult.status === 'rejected') {
        log.error('[PayPal] Submitter user batch fetch failed', { error: submitterUserResult.reason });
      }
      if (submitterArtistResult.status === 'rejected') {
        log.error('[PayPal] Submitter artist batch fetch failed', { error: submitterArtistResult.reason });
      }
      const submitterUserMap = new Map(submitterUserEntries.filter(([, doc]) => doc));
      const submitterArtistMap = new Map(submitterArtistEntries.filter(([, doc]) => doc));

      // Enrich items with seller info using pre-fetched data
      const enrichedItems = itemsList.map((item: Record<string, unknown>) => {
        const releaseId = item.releaseId || item.productId || item.id;
        let submitterId = null;
        let submitterEmail = null;
        let artistName = item.artist || item.artistName || null;

        // Look up release to get submitter info
        if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
          const release = ledgerReleaseMap.get(releaseId as string);
          if (release) {
            submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
            submitterEmail = release.email || release.submitterEmail || release.metadata?.email || null;
            artistName = release.artistName || release.artist || artistName;
          }
        }

        // For merch items, look up the merch document for seller info
        if (item.type === 'merch' && item.productId) {
          const merch = ledgerMerchMap.get(item.productId as string);
          if (merch) {
            submitterId = merch.supplierId || merch.sellerId || merch.userId || merch.createdBy || null;
            submitterEmail = merch.email || merch.sellerEmail || null;
            artistName = merch.sellerName || merch.supplierName || merch.brandName || artistName;

            // If no email on product, check pre-fetched user/artist data
            if (!submitterEmail && submitterId) {
              const userData = submitterUserMap.get(submitterId as string);
              if (userData?.email) {
                submitterEmail = userData.email;
              } else {
                const artistData = submitterArtistMap.get(submitterId as string);
                if (artistData?.email) {
                  submitterEmail = artistData.email;
                }
              }
            }
          }
        }

        return {
          ...item,
          submitterId,
          submitterEmail,
          artistName
        };
      });

      // Use multi-seller recording to create per-seller ledger entries
      // Dual-write: D1 (primary) + Firebase (backup)
      await recordMultiSellerSale({
        orderId: result.orderId,
        orderNumber: result.orderNumber || '',
        customerId: orderData.customer?.userId || null,
        customerEmail: orderData.customer?.email || '',
        customerName: orderData.customer?.displayName || orderData.customer?.firstName || null,
        grossTotal: capturedAmount,
        shipping: orderData.totals?.shipping || 0,
        paypalFee: Math.round(paypalFee * 100) / 100,
        freshWaxFee,
        paymentMethod: 'paypal',
        paymentId: paypalOrderId,
        hasPhysical: orderData.hasPhysicalItems,
        hasDigital: enrichedItems.some((i: Record<string, unknown>) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
        items: enrichedItems,
        db: env?.DB  // D1 database for dual-write
      });
      // Sale recorded to ledger
    } catch (ledgerErr: unknown) {
      log.error('[PayPal] Failed to record to ledger:', ledgerErr);
      // Don't fail the order, ledger is supplementary
    }

    // Process artist payments via Stripe Connect (same as Stripe webhook)
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (stripeSecretKey && result.orderId) {
      // Calculate total item count for fair fee splitting across all item types
      const totalItemCount = (orderData.items || []).length;

      // Calculate order subtotal for processing fee calculation
      const orderSubtotal = ((orderData.items as Record<string, unknown>[]) || []).reduce((sum: number, item: Record<string, unknown>) => {
        return sum + ((item.price || 0) * (item.quantity || 1));
      }, 0);

      // Process all seller payment types in parallel — each is independent and
      // failures in one category should not block or delay the others
      const paymentParams = {
        orderId: result.orderId!,
        orderNumber: result.orderNumber || '',
        items: orderData.items,
        totalItemCount,
        orderSubtotal,
        stripeSecretKey,
        env
      };
      const paymentResults = await Promise.allSettled([
        processArtistPayments(paymentParams),
        processMerchSupplierPayments(paymentParams),
        processVinylCrateSellerPayments(paymentParams)
      ]);
      const paymentLabels = ['Artist', 'Supplier', 'Crate seller'];
      for (let i = 0; i < paymentResults.length; i++) {
        if (paymentResults[i].status === 'rejected') {
          log.error(`[PayPal] ${paymentLabels[i]} payment processing error:`, (paymentResults[i] as PromiseRejectedResult).reason);
        }
      }
    }

    // Deduct applied credit from user's balance atomically
    const userId = orderData.customer?.userId;
    if (appliedCredit > 0 && userId) {
      // Deducting applied credit
      try {
        const creditData = await getDocument('userCredits', userId);
        if (creditData && creditData.balance >= appliedCredit) {
          const now = new Date().toISOString();

          // Atomically decrement the balance to prevent race conditions
          await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

          // Create transaction record (append separately)
          const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const newBalance = creditData.balance - appliedCredit;
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

          // Credit deducted atomically
        } else {
          log.warn('[PayPal] Insufficient credit balance for deduction');
        }
      } catch (creditErr: unknown) {
        log.error('[PayPal] Failed to deduct credit:', creditErr);
        // Don't fail the order, just log the error
      }
    }

    return successResponse({ orderId: result.orderId,
      orderNumber: result.orderNumber,
      paypalOrderId: paypalOrderId,
      captureId: captureId }, 200, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[PayPal] Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal } = params;

  try {
    // Group items by artist
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      amount: number;
      items: string[];
    }> = {};

    // Collect unique release IDs
    const releaseIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (releaseId) releaseIds.add(releaseId as string);
    }

    // Batch-fetch all releases in parallel
    const releaseEntries = await Promise.all(
      [...releaseIds].map(async (id) => {
        const doc = await getDocument('releases', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const releaseMap = new Map(releaseEntries.filter(([, doc]) => doc));

    // Collect unique artist IDs from resolved releases
    const artistIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'merch') continue;
      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;
      const release = releaseMap.get(releaseId as string);
      if (!release) continue;
      const aid = item.artistId || release.artistId || release.userId;
      if (aid) artistIds.add(aid as string);
    }

    // Batch-fetch all artists in parallel
    const artistEntries = await Promise.all(
      [...artistIds].map(async (id) => {
        const doc = await getDocument('artists', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const artistMap = new Map(artistEntries.filter(([, doc]) => doc));

    for (const item of items) {
      // Skip merch items - they go to suppliers
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      const release = releaseMap.get(releaseId as string);
      if (!release) continue;

      const artistId = (item.artistId || release.artistId || release.userId) as string;
      if (!artistId) continue;

      const artist = artistMap.get(artistId) || null;

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Artist sets full price, fees deducted from that
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const artistShare = itemTotal - freshWaxFee - processingFeePerSeller;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    // Processing artist payouts

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      // Creating pending payout

      // Always create pending payout for manual processing
      await addDocument('pendingPayouts', {
        artistId: payment.artistId,
        artistName: payment.artistName,
        artistEmail: payment.artistEmail,
        orderId,
        orderNumber,
        amount: payment.amount,
        currency: 'gbp',
        status: 'pending',
        customerPaymentMethod: 'paypal',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update artist's pending balance atomically
      try {
        await atomicIncrement('artists', payment.artistId, {
          pendingBalance: payment.amount,
        });
        await updateDocument('artists', payment.artistId, {
          updatedAt: new Date().toISOString()
        });
      } catch (e: unknown) {
        log.warn('[PayPal] Could not update artist pending balance');
      }

      // Pending payout created
    }
  } catch (error: unknown) {
    log.error('[PayPal] processArtistPayments error:', error);
    throw error;
  }
}

// Process merch supplier payments via Stripe Connect or PayPal
async function processMerchSupplierPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, items, env } = params;

  try {
    // Filter to only merch items
    const merchItems = items.filter(item => item.type === 'merch');

    if (merchItems.length === 0) {
      return;
    }

    const db = env?.DB;

    // Process each merch item for royalty tracking
    for (const item of merchItems) {
      const brandName = (item.brandName || item.categoryName || 'Fresh Wax') as string;
      const brandAccountId = (item.brandAccountId || '') as string;

      // Fresh Wax branded items = no royalty, FW keeps 100%
      if (!brandAccountId || brandName === 'Fresh Wax') {
        continue;
      }

      const itemPrice = (item.price as number) || 0;
      const quantity = (item.quantity as number) || 1;
      const saleTotal = itemPrice * quantity;

      // 10% royalty to brand, 90% to FreshWax
      const royaltyAmount = Math.round(saleTotal * 0.10 * 100) / 100;
      const freshwaxAmount = Math.round((saleTotal - royaltyAmount) * 100) / 100;

      const entryId = `roy_${orderId}_${(item.productId || item.id || Date.now())}_${Math.random().toString(36).substr(2, 6)}`;

      // Record to D1 royalty ledger
      if (db) {
        try {
          const { d1RecordRoyalty } = await import('../../../lib/d1-catalog');
          await d1RecordRoyalty(db, {
            id: entryId,
            orderId,
            brandAccountId,
            brandName,
            itemId: (item.productId || item.id || '') as string,
            itemName: (item.name || item.title || 'Item') as string,
            quantity,
            saleTotal,
            royaltyPct: 10,
            royaltyAmount,
            freshwaxAmount
          });
          log.info('[PayPal] Royalty recorded:', brandName, royaltyAmount);
        } catch (d1Err: unknown) {
          log.error('[PayPal] D1 royalty record failed:', d1Err);
        }
      }

      // Update brand's pending balance in Firebase
      try {
        await atomicIncrement('merch-suppliers', brandAccountId, {
          pendingBalance: royaltyAmount,
        });
      } catch (fbErr: unknown) {
        log.error('[PayPal] Failed to update brand pending balance:', fbErr);
      }
    }
  } catch (error: unknown) {
    log.error('[PayPal] processMerchSupplierPayments error:', error);
    // Don't throw - order was created, royalties can be retried
  }
}

// Process vinyl crate seller payments via Stripe Connect or PayPal
async function processVinylCrateSellerPayments(params: {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  const { createPayout, getPayPalConfig } = await import('../../../lib/paypal-payouts');
  const paypalConfig = getPayPalConfig(env);

  try {
    // Filter to only vinyl crate items
    const crateItems = items.filter(item =>
      item.type === 'crate' ||
      item.type === 'vinyl-crate' ||
      item.crateListingId ||
      item.sellerId
    );

    if (crateItems.length === 0) {
      // No vinyl crate items - skip seller payments
      return;
    }

    // Processing vinyl crate seller payments

    // Group items by seller
    const sellerPayments: Record<string, {
      sellerId: string;
      sellerName: string;
      sellerEmail: string;
      stripeConnectId: string | null;
      paypalEmail: string | null;
      payoutMethod: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Collect unique listing IDs that need fetching (items without a sellerId)
    const listingIds = new Set<string>();
    for (const item of crateItems) {
      if (!item.sellerId && (item.crateListingId || item.listingId)) {
        listingIds.add((item.crateListingId || item.listingId) as string);
      }
    }

    // Batch-fetch all crate listings in parallel
    const listingEntries = await Promise.all(
      [...listingIds].map(async (id) => {
        const doc = await getDocument('crateListings', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const listingMap = new Map(listingEntries.filter(([, doc]) => doc));

    // Resolve sellerIds for all crate items, then collect unique seller IDs
    const sellerIdSet = new Set<string>();
    const itemSellerIds: (string | null)[] = [];
    for (const item of crateItems) {
      let sellerId = item.sellerId as string | null;
      if (!sellerId) {
        const listingId = (item.crateListingId || item.listingId) as string | undefined;
        if (listingId) {
          const listing = listingMap.get(listingId);
          if (listing) {
            sellerId = (listing.sellerId || listing.userId) as string | null;
          }
        }
      }
      itemSellerIds.push(sellerId || null);
      if (sellerId) sellerIdSet.add(sellerId);
    }

    // Batch-fetch all sellers (users) in parallel
    const sellerEntries = await Promise.all(
      [...sellerIdSet].map(async (id) => {
        const doc = await getDocument('users', id).catch(() => null);
        return [id, doc] as const;
      })
    );
    const sellerMap = new Map(sellerEntries.filter(([, doc]) => doc));

    for (let i = 0; i < crateItems.length; i++) {
      const item = crateItems[i];
      const sellerId = itemSellerIds[i];

      if (!sellerId) {
        // No seller ID for crate item
        continue;
      }

      const seller = sellerMap.get(sellerId) || null;
      if (!seller) continue;

      // Calculate seller share (same structure as releases)
      // 1% Fresh Wax fee + payment processor fees
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const sellerShare = itemTotal - freshWaxFee - processingFeePerSeller;

      // Group by seller
      if (!sellerPayments[sellerId]) {
        sellerPayments[sellerId] = {
          sellerId,
          sellerName: seller.displayName || seller.name || 'Seller',
          sellerEmail: seller.email || '',
          stripeConnectId: seller.stripeConnectId || null,
          paypalEmail: seller.paypalEmail || null,
          payoutMethod: seller.payoutMethod || null,
          amount: 0,
          items: []
        };
      }

      sellerPayments[sellerId].amount += sellerShare;
      sellerPayments[sellerId].items.push(item.name || item.title || 'Vinyl');
    }

    // Processing vinyl crate seller payments

    // Process each seller payment
    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];

      if (payment.amount <= 0) continue;

      // Processing seller payment

      // Check preferred payout method
      const usePayPal = payment.payoutMethod === 'paypal' && payment.paypalEmail && paypalConfig;
      const useStripe = payment.stripeConnectId && payment.payoutMethod !== 'paypal';

      if (usePayPal) {
        // PayPal payout for crate seller - deduct 2% payout fee
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        // Paying crate seller via PayPal

        try {
          const paypalResult = await createPayout(paypalConfig!, {
            email: payment.paypalEmail!,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax vinyl sale payout for order #${orderNumber}`,
            reference: `${orderId}-seller-${payment.sellerId}`
          });

          if (paypalResult.success) {
            await addDocument('crateSellerPayouts', {
              sellerId: payment.sellerId,
              sellerName: payment.sellerName,
              sellerEmail: payment.sellerEmail,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: paypalResult.batchId,
              payoutMethod: 'paypal',
              customerPaymentMethod: 'paypal',
              orderId,
              orderNumber,
              amount: paypalAmount,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              items: payment.items,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            // Atomically update crate seller earnings
            await atomicIncrement('users', payment.sellerId, {
              crateEarnings: paypalAmount,
            });
            await updateDocument('users', payment.sellerId, {
              lastCratePayoutAt: new Date().toISOString()
            });

            // Crate seller PayPal payout created
          } else {
            throw new Error(paypalResult.error || 'PayPal payout failed');
          }

        } catch (paypalError: unknown) {
          const paypalMessage = paypalError instanceof Error ? paypalError.message : String(paypalError);
          log.error('[PayPal] Crate seller PayPal payout failed:', paypalMessage);

          await addDocument('pendingCrateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            paypalEmail: payment.paypalEmail,
            payoutMethod: 'paypal',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: paypalAmount,
            paypalPayoutFee: paypalPayoutFee,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: paypalMessage,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

      } else if (useStripe) {
        // Stripe transfer for crate seller
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100),
            currency: 'gbp',
            destination: payment.stripeConnectId!,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              sellerId: payment.sellerId,
              sellerName: payment.sellerName,
              type: 'vinyl_crate_seller',
              platform: 'freshwax',
              customerPaymentMethod: 'paypal'
            }
          });

          await addDocument('crateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            stripeConnectId: payment.stripeConnectId,
            stripeTransferId: transfer.id,
            payoutMethod: 'stripe',
            customerPaymentMethod: 'paypal',
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            items: payment.items,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Atomically update crate seller earnings
          await atomicIncrement('users', payment.sellerId, {
            crateEarnings: payment.amount,
          });
          await updateDocument('users', payment.sellerId, {
            lastCratePayoutAt: new Date().toISOString()
          });

          // Crate seller Stripe transfer created

        } catch (transferError: unknown) {
          const transferMessage = transferError instanceof Error ? transferError.message : String(transferError);
          log.error('[PayPal] Crate seller transfer failed:', transferMessage);

          await addDocument('pendingCrateSellerPayouts', {
            sellerId: payment.sellerId,
            sellerName: payment.sellerName,
            sellerEmail: payment.sellerEmail,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'retry_pending',
            items: payment.items,
            failureReason: transferMessage,
            customerPaymentMethod: 'paypal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        // Seller not connected - store as pending
        // Crate seller not connected - storing pending

        await addDocument('pendingCrateSellerPayouts', {
          sellerId: payment.sellerId,
          sellerName: payment.sellerName,
          sellerEmail: payment.sellerEmail,
          orderId,
          orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'awaiting_connect',
          items: payment.items,
          notificationSent: false,
          customerPaymentMethod: 'paypal',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
  } catch (error: unknown) {
    log.error('[PayPal] processVinylCrateSellerPayments error:', error);
    throw error;
  }
}
