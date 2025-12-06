// src/pages/api/giftcards/balance.ts
// Get user's credit balance and transaction history

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Get user credit document
    const creditDoc = await db.collection('userCredits').doc(userId).get();
    
    if (!creditDoc.exists) {
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
    
    const creditData = creditDoc.data()!;
    
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
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { userId, amount, orderId, orderNumber } = data;
    
    if (!userId || !amount || amount <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Get current balance
    const creditRef = db.collection('userCredits').doc(userId);
    const creditDoc = await creditRef.get();
    
    if (!creditDoc.exists) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No credit balance found'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const creditData = creditDoc.data()!;
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
    const { FieldValue } = await import('firebase-admin/firestore');
    
    await creditRef.update({
      balance: newBalance,
      lastUpdated: now,
      transactions: FieldValue.arrayUnion(transaction)
    });
    
    // Also update customer document
    await db.collection('customers').doc(userId).update({
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
