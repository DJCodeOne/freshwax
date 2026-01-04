// src/pages/api/giftcards/balance.ts
// Get user's credit balance and transaction history - uses Firebase REST API
// SECURITY: Requires authentication - user can only view their own balance
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

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
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // SECURITY: Verify the requesting user's identity
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await request.json();
    const { amount, orderId, orderNumber } = data;

    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get current balance
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
      amount: -amount, // negative for debit
      description: `Applied to order ${orderNumber || orderId}`,
      orderId,
      createdAt: now,
      balanceAfter: newBalance
    };

    // Update credit balance
    const existingTransactions = creditData.transactions || [];
    existingTransactions.push(transaction);

    await updateDocument('userCredits', userId, {
      balance: newBalance,
      lastUpdated: now,
      transactions: existingTransactions
    });

    // Also update customer document
    await updateDocument('customers', userId, {
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

  } catch (error) {
    console.error('[giftcards/balance] Error applying credit:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to apply credit'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
