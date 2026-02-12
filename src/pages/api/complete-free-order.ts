// src/pages/api/complete-free-order.ts
// Handles free orders (total = 0) and credit-paid orders without payment processing

import type { APIRoute } from 'astro';
import { createOrder, validateStock } from '../../lib/order-utils';
import { initFirebaseEnv, getDocument, updateDocument, atomicIncrement, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { recordMultiSellerSale } from '../../lib/sales-ledger';

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
                serverPrice = release.price || release.digitalPrice || item.price;
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
    const env = (locals as any)?.runtime?.env;

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    // Parse request body
    const orderData = await request.json();

    // Validate required fields
    if (!orderData.customer?.email || !orderData.customer?.firstName || !orderData.customer?.lastName) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required customer details'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!orderData.items || orderData.items.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Order must contain at least one item'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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
      return new Response(JSON.stringify({
        success: false,
        error: 'Unable to verify item prices. Please try again.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // SECURITY: Always require authentication for free/credit orders
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (!verifiedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the userId in the order matches the authenticated user
    if (orderData.customer?.userId && orderData.customer.userId !== verifiedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User mismatch'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // SECURITY: If credit is applied, verify balance covers the order
    if (appliedCredit > 0) {
      const creditData = await getDocument('userCredits', verifiedUserId);
      const actualBalance = creditData?.balance || 0;
      if (actualBalance < validatedTotal) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Insufficient credit balance'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // SECURITY: Validate stock availability before processing order
    const stockCheck = await validateStock(validatedItems);
    if (!stockCheck.available) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Some items are no longer available',
        unavailableItems: stockCheck.unavailableItems
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify this is actually a free/credit-paid order (no payment due)
    const paymentDue = Math.max(0, validatedTotal - appliedCredit);
    if (paymentDue > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This endpoint is only for free or fully credit-paid orders'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SECURITY: Deduct credit BEFORE creating order to prevent race condition
    let creditDeducted = false;
    if (appliedCredit > 0) {
      try {
        await atomicIncrement('userCredits', verifiedUserId, { balance: -appliedCredit });
        await atomicIncrement('users', verifiedUserId, { creditBalance: -appliedCredit });
        creditDeducted = true;
        console.log('[FreeOrder] Credit deducted before order creation:', appliedCredit, 'from user:', verifiedUserId);
      } catch (creditErr) {
        console.error('[FreeOrder] Failed to deduct credit before order:', creditErr);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to apply credit. Please try again.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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
                console.log(`[FreeOrder] Item ${item.name}: seller=${submitterId}, email=${submitterEmail || 'NOT SET'}`);
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

          const existingTransactions = creditData?.transactions || [];
          existingTransactions.push(transaction);

          await updateDocument('userCredits', verifiedUserId, {
            lastUpdated: now,
            transactions: existingTransactions
          });

          await updateDocument('users', verifiedUserId, { creditUpdatedAt: now });

          console.log('[FreeOrder] Credit transaction recorded:', appliedCredit, 'from user:', verifiedUserId, 'balance:', currentBalance);
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
      return new Response(JSON.stringify({
        success: false,
        error: result.error || 'Failed to create order'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[complete-free-order] Error:', errorMessage);

    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
