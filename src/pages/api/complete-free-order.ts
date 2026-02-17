// src/pages/api/complete-free-order.ts
// Handles free orders (total = 0) and credit-paid orders without payment processing

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { createOrder, validateStock } from '../../lib/order-utils';
import { getDocument, queryCollection, updateDocument, atomicIncrement, arrayUnion, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { recordMultiSellerSale } from '../../lib/sales-ledger';
import { ApiErrors } from '../../lib/api-utils';

// Zod schemas for free/credit order
const FreeOrderItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  releaseId: z.string().optional(),
  trackId: z.string().optional(),
  name: z.string().min(1).max(500),
  type: z.enum(['digital', 'track', 'release', 'vinyl', 'merch']).optional(),
  price: z.number().min(0),
  quantity: z.number().int().min(1).max(99).default(1),
  size: z.string().optional(),
  color: z.string().optional(),
  artist: z.string().optional(),
  artistId: z.string().optional(),
  sellerId: z.string().optional(),
}).passthrough();

const FreeOrderCustomerSchema = z.object({
  email: z.string().email('Valid email required'),
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  phone: z.string().optional(),
  userId: z.string().optional(),
}).passthrough();

const FreeOrderSchema = z.object({
  customer: FreeOrderCustomerSchema,
  items: z.array(FreeOrderItemSchema).min(1, 'At least one item required').max(50),
  shipping: z.object({
    address1: z.string().optional(),
    address2: z.string().optional(),
    city: z.string().optional(),
    county: z.string().optional(),
    postcode: z.string().optional(),
    country: z.string().optional(),
  }).passthrough().optional().nullable(),
  appliedCredit: z.number().min(0).optional(),
  idToken: z.string().optional(),
}).passthrough();

export const prerender = false;

// SECURITY: Validate item prices server-side to prevent getting items for free
async function validateAndGetPrices(items: any[]): Promise<{ validatedItems: any[], validatedSubtotal: number }> {
  const validatedItems: any[] = [];

  for (const item of items) {
    let serverPrice = item.price;
    const itemType = item.type || 'digital';

    try {
      if (itemType === 'merch' && item.productId) {
        const product = await getDocument('merch', item.productId);
        if (product) {
          serverPrice = product.salePrice || product.retailPrice || product.price || item.price;
        }
      } else if (itemType === 'vinyl' || itemType === 'digital' || itemType === 'track' || itemType === 'release') {
        if (itemType === 'vinyl' && item.sellerId && !item.releaseId) {
          const listingId = item.id || item.productId;
          if (listingId) {
            const listing = await getDocument('vinylListings', listingId);
            if (listing) serverPrice = listing.price || item.price;
          }
        } else {
          const releaseId = item.releaseId || item.productId || item.id;
          if (releaseId) {
            const release = await getDocument('releases', releaseId);
            if (release) {
              if (itemType === 'vinyl') {
                serverPrice = release.vinylPrice || release.price || item.price;
              } else if (itemType === 'track' && item.trackId) {
                const track = (release.tracks || []).find((t: any) =>
                  t.id === item.trackId || t.trackId === item.trackId
                );
                serverPrice = track?.price || release.trackPrice || 0.99;
              } else {
                serverPrice = release.price || release.digitalPrice;
              if (serverPrice == null || serverPrice <= 0) {
                validatedItems.push({ ...item, price: item.price || 0, priceValidationFailed: true });
                continue;
              }
              }
            }
          }
        }
      }

      validatedItems.push({ ...item, price: serverPrice });
    } catch (err) {
      console.error('[FreeOrder] Price validation error for', item.name, err);
      // SECURITY: On price lookup failure, use server price of 0 is NOT safe
      // Reject items where we can't verify the price
      validatedItems.push({ ...item, price: item.price || 0, priceValidationFailed: true });
    }
  }

  const validatedSubtotal = validatedItems.reduce((sum: number, item: any) =>
    sum + ((item.price || 0) * (item.quantity || 1)), 0);

  return { validatedItems, validatedSubtotal };
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: strict - 5 per minute (prevent order abuse)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`complete-free-order:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    // Parse and validate request body
    const rawBody = await request.json();

    const parseResult = FreeOrderSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const orderData = parseResult.data;

    // SECURITY: Validate item prices server-side (prevent getting items for free)
    const { validatedItems, validatedSubtotal } = await validateAndGetPrices(orderData.items);
    const hasPhysicalItems = validatedItems.some((item: any) =>
      item.type === 'vinyl' || item.type === 'merch');
    const shipping = hasPhysicalItems ? (validatedSubtotal >= 50 ? 0 : 4.99) : 0;
    const validatedTotal = validatedSubtotal + shipping;

    const appliedCredit = orderData.appliedCredit || 0;

    // SECURITY: Reject orders with items that failed price validation
    const failedItems = validatedItems.filter((item: any) => item.priceValidationFailed);
    if (failedItems.length > 0) {
      return ApiErrors.badRequest('Unable to verify item prices. Please try again.');
    }

    // SECURITY: Always require authentication for free/credit orders
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (!verifiedUserId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    // Verify the userId in the order matches the authenticated user
    if (orderData.customer?.userId && orderData.customer.userId !== verifiedUserId) {
      return ApiErrors.forbidden('User mismatch');
    }

    // SECURITY: If credit is applied, verify balance covers the order
    if (appliedCredit > 0) {
      const creditData = await getDocument('userCredits', verifiedUserId);
      const actualBalance = creditData?.balance || 0;
      if (actualBalance < validatedTotal) {
        return ApiErrors.badRequest('Insufficient credit balance');
      }
    }

    // SECURITY: Validate stock availability before processing order
    const stockCheck = await validateStock(validatedItems);
    if (!stockCheck.available) {
      return ApiErrors.badRequest('Some items are no longer available');
    }

    // Reserve and immediately convert stock for free orders
    const { reserveStock, convertReservation } = await import('../../lib/order-utils');
    const reservation = await reserveStock(validatedItems, 'free_' + Date.now().toString(36), verifiedUserId);
    if (!reservation.success) {
      return ApiErrors.badRequest(reservation.error || 'Failed to reserve stock');
    }

    // SECURITY: Idempotency check - prevent duplicate free orders
    const orderKey = `${verifiedUserId}:${validatedItems.map((i: any) => `${i.id || i.productId}:${i.quantity}`).join(',')}`;
    const recentOrders = await queryCollection('orders', {
      filters: [
        { field: 'customer.userId', op: 'EQUAL', value: verifiedUserId },
        { field: 'paymentMethod', op: 'IN', value: ['free', 'credit'] }
      ],
      orderBy: 'createdAt',
      orderDirection: 'DESCENDING',
      limit: 5
    });
    if (recentOrders && recentOrders.length > 0) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const duplicate = recentOrders.find((order: any) => {
        if (!order.createdAt || order.createdAt < fiveMinutesAgo) return false;
        const orderItemKeys = (order.items || []).map((i: any) => `${i.id || i.productId}:${i.quantity}`).join(',');
        const currentItemKeys = validatedItems.map((i: any) => `${i.id || i.productId}:${i.quantity}`).join(',');
        return orderItemKeys === currentItemKeys;
      });
      if (duplicate) {
        console.log('[FreeOrder] Duplicate order detected, returning existing:', duplicate.id);
        return new Response(JSON.stringify({
          success: true,
          orderId: duplicate.id,
          orderNumber: duplicate.orderNumber,
          duplicate: true
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Verify this is actually a free/credit-paid order (no payment due)
    const paymentDue = Math.max(0, validatedTotal - appliedCredit);
    if (paymentDue > 0) {
      return ApiErrors.badRequest('This endpoint is only for free or fully credit-paid orders');
    }

    // SECURITY: Deduct credit BEFORE creating order to prevent race condition
    let creditDeducted = false;
    if (appliedCredit > 0) {
      try {
        await atomicIncrement('userCredits', verifiedUserId, { balance: -appliedCredit });
        await atomicIncrement('users', verifiedUserId, { creditBalance: -appliedCredit });
        creditDeducted = true;
        console.log('[FreeOrder] Credit deducted before order creation:', appliedCredit);
      } catch (creditErr) {
        console.error('[FreeOrder] Failed to deduct credit before order:', creditErr);
        return ApiErrors.serverError('Failed to apply credit. Please try again.');
      }
    }

    // Use validated totals, not client-sent values
    const totals = appliedCredit > 0 ? {
      subtotal: validatedSubtotal,
      shipping,
      total: validatedTotal,
      appliedCredit,
      amountPaid: 0
    } : {
      subtotal: 0,
      shipping: 0,
      freshWaxFee: 0,
      stripeFee: 0,
      serviceFees: 0,
      total: 0,
      appliedCredit: 0,
      amountPaid: 0
    };

    // Create the order using the shared order creation utility
    let result: any;
    try {
      result = await createOrder({
        orderData: {
          customer: orderData.customer,
          shipping: orderData.shipping || null,
          items: validatedItems,
          totals,
          hasPhysicalItems: hasPhysicalItems || false,
          paymentMethod: appliedCredit > 0 ? 'credit' : 'free',
          paymentIntentId: null,
          paypalOrderId: null
        },
        env,
        idToken: orderData.idToken
      });
    } catch (orderErr) {
      // If credit was deducted but order creation failed, refund the credit
      if (creditDeducted) {
        try {
          await atomicIncrement('userCredits', verifiedUserId, { balance: appliedCredit });
          await atomicIncrement('users', verifiedUserId, { creditBalance: appliedCredit });
          console.log('[FreeOrder] Refunded credit after order creation failure:', appliedCredit);
        } catch (refundErr) {
          console.error('[FreeOrder] CRITICAL: Failed to refund credit after order failure:', refundErr);
        }
      }
      throw orderErr;
    }

    if (result.success) {
      // Convert stock reservation (payment succeeded for free order)
      if (reservation.reservationId) {
        await convertReservation(reservation.reservationId);
      }

      // Record to sales ledger (even for free/credit orders for accurate tracking)
      try {
        const enrichedItems = await Promise.all((validatedItems || []).map(async (item: any) => {
          const releaseId = item.releaseId || item.productId || item.id;
          let submitterId = null;
          let submitterEmail = null;
          let artistName = item.artist || item.artistName || null;

          if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
            try {
              const release = await getDocument('releases', releaseId);
              if (release) {
                submitterId = release.submitterId || release.uploadedBy || release.userId || release.submittedBy || null;
                submitterEmail = release.email || release.submitterEmail || release.metadata?.email || null;
                artistName = release.artistName || release.artist || artistName;
                console.log(`[FreeOrder] Item ${item.name}: seller=${submitterId ? 'SET' : 'NONE'}`);
              }
            } catch (lookupErr) {
              console.error(`[FreeOrder] Failed to lookup release ${releaseId}:`, lookupErr);
            }
          }

          return {
            ...item,
            submitterId,
            submitterEmail,
            artistName
          };
        }));

        await recordMultiSellerSale({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          customerId: orderData.customer?.userId || null,
          customerEmail: orderData.customer?.email || '',
          customerName: orderData.customer?.displayName || orderData.customer?.firstName || null,
          grossTotal: validatedTotal,
          shipping: totals.shipping || 0,
          paymentMethod: appliedCredit > 0 ? 'giftcard' : 'free',
          paymentId: null,
          hasPhysical: hasPhysicalItems || false,
          hasDigital: enrichedItems.some((i: any) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
          items: enrichedItems,
          db: env?.DB
        });
        console.log('[FreeOrder] Sale recorded to ledger (D1 + Firebase)');
      } catch (ledgerErr) {
        console.error('[FreeOrder] Failed to record to ledger:', ledgerErr);
      }

      // If credit was applied (already deducted before order creation), record the transaction
      if (creditDeducted && appliedCredit > 0) {
        try {
          const now = new Date().toISOString();
          const creditData = await getDocument('userCredits', verifiedUserId);
          const currentBalance = creditData?.balance || 0;

          const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const transaction = {
            id: transactionId,
            type: 'purchase',
            amount: -appliedCredit,
            description: `Applied to order ${result.orderNumber || result.orderId}`,
            orderId: result.orderId,
            orderNumber: result.orderNumber,
            createdAt: now,
            balanceAfter: currentBalance
          };

          // Atomic arrayUnion prevents lost transactions under concurrent writes
          await arrayUnion('userCredits', verifiedUserId, 'transactions', [transaction], {
            lastUpdated: now
          });

          await updateDocument('users', verifiedUserId, { creditUpdatedAt: now });

          console.log('[FreeOrder] Credit transaction recorded:', appliedCredit, 'balance:', currentBalance);
        } catch (txnErr) {
          console.error('[FreeOrder] Failed to record credit transaction:', txnErr);
          // Credit already deducted, transaction record is non-critical
        }
      }

      return new Response(JSON.stringify({
        success: true,
        orderId: result.orderId,
        orderNumber: result.orderNumber
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      // Order creation returned failure - refund credit if it was deducted
      if (creditDeducted) {
        try {
          await atomicIncrement('userCredits', verifiedUserId, { balance: appliedCredit });
          await atomicIncrement('users', verifiedUserId, { creditBalance: appliedCredit });
          console.log('[FreeOrder] Refunded credit after order failure:', appliedCredit);
        } catch (refundErr) {
          console.error('[FreeOrder] CRITICAL: Failed to refund credit after order failure:', refundErr);
        }
      }
      return ApiErrors.serverError(result.error || 'Failed to create order');
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[complete-free-order] Error:', errorMessage);

    return ApiErrors.serverError('An internal error occurred');
  }
};
