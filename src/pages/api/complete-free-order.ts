// src/pages/api/complete-free-order.ts
// Handles free orders (total = 0) and credit-paid orders without payment processing

import type { APIRoute } from 'astro';
import { createOrder } from '../../lib/order-utils';
import { initFirebaseEnv, getDocument, updateDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

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

    // Calculate final payment amount (total minus any applied credit)
    const originalTotal = orderData.totals?.total || 0;
    const appliedCredit = orderData.appliedCredit || 0;
    const paymentDue = Math.max(0, originalTotal - appliedCredit);

    // Verify this is actually a free/credit-paid order (no payment due)
    if (paymentDue > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This endpoint is only for free or fully credit-paid orders'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

    // Keep original totals for record keeping, add applied credit info
    const totals = appliedCredit > 0 ? {
      ...orderData.totals,
      appliedCredit,
      amountPaid: 0 // Paid via credit
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
    const result = await createOrder({
      orderData: {
        customer: orderData.customer,
        shipping: orderData.shipping || null,
        items: orderData.items,
        totals,
        hasPhysicalItems: orderData.hasPhysicalItems || false,
        paymentMethod: appliedCredit > 0 ? 'credit' : 'free',
        paymentIntentId: null,
        paypalOrderId: null
      },
      env,
      idToken: orderData.idToken
    });

    if (result.success) {
      // If credit was applied, deduct it from user's balance
      if (appliedCredit > 0 && orderData.customer?.userId) {
        try {
          const userId = orderData.customer.userId;
          const creditData = await getDocument('userCredits', userId);

          if (creditData && creditData.balance >= appliedCredit) {
            const newBalance = creditData.balance - appliedCredit;
            const now = new Date().toISOString();

            // Create transaction record
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

            const existingTransactions = creditData.transactions || [];
            existingTransactions.push(transaction);

            await updateDocument('userCredits', userId, {
              balance: newBalance,
              lastUpdated: now,
              transactions: existingTransactions
            });

            // Also update user document
            await updateDocument('users', userId, {
              creditBalance: newBalance,
              creditUpdatedAt: now
            });

            console.log('[FreeOrder] Deducted credit:', appliedCredit, 'from user:', userId, 'new balance:', newBalance);
          }
        } catch (creditErr) {
          console.error('[FreeOrder] Failed to deduct credit:', creditErr);
          // Don't fail the order, just log the error
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

    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
