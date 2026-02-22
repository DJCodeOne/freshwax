// src/pages/api/giftcards/balance.ts
// Get user's credit balance and transaction history - uses Firebase REST API
// SECURITY: Requires authentication - user can only view their own balance
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, updateDocumentConditional, verifyRequestUser } from '../../../lib/firebase-rest';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[giftcards/balance]');

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
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    // Get user credit document
    const creditData = await getDocument('userCredits', userId);

    if (!creditData) {
      // No credit document yet - return zero balance
      return successResponse({ balance: 0,
        transactions: [] });
    }

    // Sort transactions by date (newest first)
    const transactions = (creditData.transactions || [])
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime());

    return successResponse({ balance: creditData.balance || 0,
      lastUpdated: creditData.lastUpdated,
      transactions });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to get balance');
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
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const rawBody = await request.json();

    const parseResult = ApplyCreditSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { amount, orderId, orderNumber } = parseResult.data;

    // SECURITY: Use conditional update to prevent double-spend race conditions
    // Retry up to 3 times in case of concurrent modification
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Get current balance (fresh read each attempt)
      const creditData = await getDocument('userCredits', userId);

      if (!creditData) {
        return ApiErrors.badRequest('No credit balance found');
      }

      const currentBalance = creditData.balance || 0;

      if (amount > currentBalance) {
        return ApiErrors.badRequest('Insufficient credit balance');
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

        log.info('Applied credit:', amount, 'for user:', userId, 'order:', orderId);

        return successResponse({ amountApplied: amount,
          newBalance,
          transactionId });
      } catch (condError: unknown) {
        if (attempt < MAX_RETRIES - 1 && condError instanceof Error && condError.message.includes('condition')) {
          log.warn('Concurrent modification, retrying...', attempt + 1);
          continue;
        }
        throw condError;
      }
    }

    return ApiErrors.conflict('Could not apply credit due to concurrent access. Please try again.');

  } catch (error: unknown) {
    log.error('Error applying credit:', error);
    return ApiErrors.serverError('Failed to apply credit');
  }
};
