// src/pages/api/giftcards/balance.ts
// Get user's credit balance and transaction history - uses Firebase REST API
// SECURITY: Requires authentication - user can only view their own balance
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, updateDocumentConditional, verifyRequestUser } from '../../../lib/firebase-rest';

// Zod schema for applying credit to an order
const ApplyCreditSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  orderId: z.string().optional(),
  orderNumber: z.string().optional(),
}).passthrough();

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    // SECURITY: Verify the requesting user's identity
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Get user credit document
    const creditData = await getDocument('userCredits', userId);

    if (!creditData) {
      // No credit document yet - return zero balance
      return new Response(JSON.stringify({
        success: true,
        balance: 0,
        transactions: []
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Sort transactions by date (newest first)
    const transactions = (creditData.transactions || [])
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return new Response(JSON.stringify({
      success: true,
      balance: creditData.balance || 0,
      lastUpdated: creditData.lastUpdated,
      transactions
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[giftcards/balance] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get balance'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST to apply credit to an order
// SECURITY: Requires authentication - user can only use their own credit
export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    // SECURITY: Verify the requesting user's identity
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const rawBody = await request.json();

    const parseResult = ApplyCreditSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Invalid request',
        details: parseResult.error.issues
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const { amount, orderId, orderNumber } = parseResult.data;

    // SECURITY: Use conditional update to prevent double-spend race conditions
    // Retry up to 3 times in case of concurrent modification
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Get current balance (fresh read each attempt)
      const creditData = await getDocument('userCredits', userId);

      if (!creditData) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No credit balance found'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const currentBalance = creditData.balance || 0;

      if (amount > currentBalance) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Insufficient credit balance'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const newBalance = currentBalance - amount;
      const now = new Date().toISOString();

      // Create transaction record
      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const transaction = {
        id: transactionId,
        type: 'purchase',
        amount: -amount,
        description: `Applied to order ${orderNumber || orderId}`,
        orderId,
        createdAt: now,
        balanceAfter: newBalance
      };

      const existingTransactions = creditData.transactions || [];
      existingTransactions.push(transaction);

      try {
        // Conditional update: only succeeds if document hasn't changed since our read
        await updateDocumentConditional('userCredits', userId, {
          balance: newBalance,
          lastUpdated: now,
          transactions: existingTransactions
        }, creditData._updateTime);

        // Also update customer document
        await updateDocument('users', userId, {
          creditBalance: newBalance,
          creditUpdatedAt: now
        });

        console.log('[giftcards/balance] Applied credit:', amount, 'for user:', userId, 'order:', orderId);

        return new Response(JSON.stringify({
          success: true,
          amountApplied: amount,
          newBalance,
          transactionId
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (condError: unknown) {
        if (attempt < MAX_RETRIES - 1 && condError instanceof Error && condError.message.includes('condition')) {
          console.warn('[giftcards/balance] Concurrent modification, retrying...', attempt + 1);
          continue;
        }
        throw condError;
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Could not apply credit due to concurrent access. Please try again.'
    }), { status: 409, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[giftcards/balance] Error applying credit:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to apply credit'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
