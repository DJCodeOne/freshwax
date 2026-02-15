// src/pages/api/giftcards/credit-account.ts
// Directly credit an account with store credit (for testing / admin use)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, atomicIncrement, arrayUnion } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    const env2 = locals.runtime.env;
    initAdminEnv({ ADMIN_UIDS: env2?.ADMIN_UIDS, ADMIN_EMAILS: env2?.ADMIN_EMAILS });

    const data = await request.json();
    const authError = await requireAdminAuth(request, locals, data);
    if (authError) return authError;

    const { userId, amount, reason, isWelcomeCredit } = data;

    if (!userId || !amount) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and amount are required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const creditAmount = parseFloat(amount);
    if (isNaN(creditAmount) || creditAmount <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid amount'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

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
    } catch (error) {
      // Customer doc might not exist yet, that's ok
    }

    console.log(`[credit-account] Credited £${creditAmount} to user ${userId}. New balance: £${newBalance}`);

    return new Response(JSON.stringify({
      success: true,
      amountCredited: creditAmount,
      newBalance,
      transactionId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[credit-account] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to credit account'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
