// src/pages/api/giftcards/credit-account.ts
// Directly credit an account with store credit (for testing / admin use)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, atomicIncrement, arrayUnion } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[credit-account]');

// Zod schema for admin credit account
const CreditAccountSchema = z.object({
  userId: z.string().min(1, 'User ID required'),
  amount: z.union([z.number(), z.string()]).refine(val => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    return !isNaN(num) && num > 0;
  }, 'Amount must be a positive number'),
  reason: z.string().max(500).optional(),
  isWelcomeCredit: z.boolean().optional(),
}).passthrough();

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    const env2 = locals.runtime.env;
    initAdminEnv({ ADMIN_UIDS: env2?.ADMIN_UIDS, ADMIN_EMAILS: env2?.ADMIN_EMAILS });

    const rawBody = await request.json();
    const authError = await requireAdminAuth(request, locals, rawBody);
    if (authError) return authError;

    const parseResult = CreditAccountSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId, amount, reason, isWelcomeCredit } = parseResult.data;

    const creditAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

    const now = new Date().toISOString();
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Get or create user credit document
    const creditDoc = await getDocument('userCredits', userId);

    let newBalance: number;

    const transaction = {
      id: transactionId,
      type: isWelcomeCredit ? 'welcome_credit' : 'admin_credit',
      amount: creditAmount,
      description: reason || (isWelcomeCredit ? '£50 Welcome Credit' : 'Admin credit adjustment'),
      createdAt: now,
      balanceAfter: 0 // Will be set below
    };

    if (!creditDoc) {
      // Create the document first if it doesn't exist
      await setDocument('userCredits', userId, {
        userId,
        balance: 0,
        lastUpdated: now,
        transactions: []
      });
    }

    // Atomically increment balance to prevent race conditions
    const result = await atomicIncrement('userCredits', userId, { balance: creditAmount });
    newBalance = result.newValues.balance ?? ((creditDoc?.balance || 0) + creditAmount);
    transaction.balanceAfter = newBalance;

    // Atomic arrayUnion prevents lost transactions under concurrent writes
    await arrayUnion('userCredits', userId, 'transactions', [transaction], {
      lastUpdated: now
    });

    // Also update customer document
    try {
      await updateDocument('users', userId, {
        creditBalance: newBalance,
        creditUpdatedAt: now
      });
    } catch (error: unknown) {
      // Customer doc might not exist yet, that's ok
    }

    log.info(`Credited £${creditAmount} to user ${userId}. New balance: £${newBalance}`);

    return new Response(JSON.stringify({
      success: true,
      amountCredited: creditAmount,
      newBalance,
      transactionId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to credit account');
  }
};
