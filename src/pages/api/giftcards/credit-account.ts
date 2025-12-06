// src/pages/api/giftcards/credit-account.ts
// Directly credit an account with store credit (for testing / admin use)

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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
    const creditRef = db.collection('userCredits').doc(userId);
    const creditDoc = await creditRef.get();
    
    let newBalance: number;
    
    if (creditDoc.exists) {
      const currentData = creditDoc.data()!;
      newBalance = (currentData.balance || 0) + creditAmount;
      
      await creditRef.update({
        balance: newBalance,
        lastUpdated: now,
        transactions: FieldValue.arrayUnion({
          id: transactionId,
          type: isWelcomeCredit ? 'welcome_credit' : 'admin_credit',
          amount: creditAmount,
          description: reason || (isWelcomeCredit ? '£50 Welcome Credit' : 'Admin credit adjustment'),
          createdAt: now,
          balanceAfter: newBalance
        })
      });
    } else {
      newBalance = creditAmount;
      
      await creditRef.set({
        userId,
        balance: newBalance,
        lastUpdated: now,
        transactions: [{
          id: transactionId,
          type: isWelcomeCredit ? 'welcome_credit' : 'admin_credit',
          amount: creditAmount,
          description: reason || (isWelcomeCredit ? '£50 Welcome Credit' : 'Admin credit adjustment'),
          createdAt: now,
          balanceAfter: newBalance
        }]
      });
    }
    
    // Also update customer document
    await db.collection('customers').doc(userId).update({
      creditBalance: newBalance,
      creditUpdatedAt: now
    }).catch(() => {
      // Customer doc might not exist yet, that's ok
    });
    
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
