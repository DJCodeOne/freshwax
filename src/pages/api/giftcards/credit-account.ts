// src/pages/api/giftcards/credit-account.ts
// Directly credit an account with store credit (for testing / admin use)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument } from '../../../lib/firebase-rest';

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { userId, amount, reason, adminKey, isWelcomeCredit } = data;

    if (!userId || !amount) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and amount are required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate admin key for non-welcome credits
    if (!isWelcomeCredit && adminKey !== 'freshwax-admin-2024') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
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

    if (creditDoc) {
      newBalance = (creditDoc.balance || 0) + creditAmount;
      transaction.balanceAfter = newBalance;

      const existingTransactions = creditDoc.transactions || [];
      await updateDocument('userCredits', userId, {
        balance: newBalance,
        lastUpdated: now,
        transactions: [...existingTransactions, transaction]
      });
    } else {
      newBalance = creditAmount;
      transaction.balanceAfter = newBalance;

      await setDocument('userCredits', userId, {
        userId,
        balance: newBalance,
        lastUpdated: now,
        transactions: [transaction]
      });
    }

    // Also update customer document
    try {
      await updateDocument('customers', userId, {
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
