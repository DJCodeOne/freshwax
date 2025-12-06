// src/pages/api/giftcards/redeem.ts
// Redeem a gift card code and add to user's credit balance

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { isValidCodeFormat, isExpired, formatGBP } from '../../../lib/giftcard';

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
    const { code, userId } = data;
    
    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Gift card code is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You must be logged in to redeem a gift card'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    
    const normalizedCode = code.toUpperCase().trim();
    
    // Validate code format
    if (!isValidCodeFormat(normalizedCode)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid gift card code format'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Find the gift card
    const giftCardQuery = await db.collection('giftCards')
      .where('code', '==', normalizedCode)
      .limit(1)
      .get();
    
    if (giftCardQuery.empty) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Gift card not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    const giftCardDoc = giftCardQuery.docs[0];
    const giftCard = giftCardDoc.data();
    
    // Check if already redeemed
    if (giftCard.redeemedBy) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card has already been redeemed'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Check if active
    if (!giftCard.isActive) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card is no longer active'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Check if expired
    if (isExpired(giftCard.expiresAt)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card has expired'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Check balance
    if (giftCard.currentBalance <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card has no remaining balance'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const amountToCredit = giftCard.currentBalance;
    const now = new Date().toISOString();
    
    // Start transaction to update both gift card and user credit
    const batch = db.batch();
    
    // Update gift card as redeemed
    batch.update(giftCardDoc.ref, {
      redeemedBy: userId,
      redeemedAt: now,
      currentBalance: 0,
      isActive: false
    });
    
    // Get or create user credit document
    const creditRef = db.collection('userCredits').doc(userId);
    const creditDoc = await creditRef.get();
    
    let newBalance: number;
    let previousBalance: number = 0;
    
    if (creditDoc.exists) {
      const creditData = creditDoc.data()!;
      previousBalance = creditData.balance || 0;
      newBalance = previousBalance + amountToCredit;
    } else {
      newBalance = amountToCredit;
    }
    
    // Create transaction record
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const transaction = {
      id: transactionId,
      type: 'gift_card_redemption',
      amount: amountToCredit,
      description: `Redeemed gift card ${normalizedCode} - ${giftCard.description || ''}`,
      giftCardCode: normalizedCode,
      createdAt: now,
      balanceAfter: newBalance
    };
    
    // Update or create credit document
    if (creditDoc.exists) {
      batch.update(creditRef, {
        balance: newBalance,
        lastUpdated: now,
        transactions: FieldValue.arrayUnion(transaction)
      });
    } else {
      batch.set(creditRef, {
        userId,
        balance: newBalance,
        lastUpdated: now,
        transactions: [transaction]
      });
    }
    
    // Also update the customer document with the new balance for quick access
    const customerRef = db.collection('customers').doc(userId);
    batch.update(customerRef, {
      creditBalance: newBalance,
      creditUpdatedAt: now
    });
    
    await batch.commit();
    
    console.log('[giftcards/redeem] Redeemed:', normalizedCode, 'for user:', userId, 'amount:', amountToCredit);
    
    return new Response(JSON.stringify({
      success: true,
      message: `Successfully redeemed ${formatGBP(amountToCredit)}!`,
      amountCredited: amountToCredit,
      newBalance,
      giftCard: {
        code: normalizedCode,
        type: giftCard.type,
        description: giftCard.description
      }
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[giftcards/redeem] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to redeem gift card'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
