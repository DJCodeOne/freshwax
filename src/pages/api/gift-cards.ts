// src/pages/api/gift-cards.ts
// Gift card management: create, validate, redeem, list

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Initialize Firebase Admin
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

// Generate unique gift card code
function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars
  let code = 'FW-';
  for (let i = 0; i < 4; i++) {
    if (i > 0) code += '-';
    for (let j = 0; j < 4; j++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  }
  return code;
}

// GET: List gift cards (admin) or validate a code
export const GET: APIRoute = async ({ url }) => {
  try {
    const params = new URL(url).searchParams;
    const action = params.get('action');
    
    // Validate a gift card code
    if (action === 'validate') {
      const code = params.get('code')?.toUpperCase().trim();
      
      if (!code) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Gift card code is required' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const snapshot = await db.collection('gift-cards')
        .where('code', '==', code)
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Invalid gift card code' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const giftCard = snapshot.docs[0].data();
      
      if (giftCard.status === 'used') {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'This gift card has already been fully redeemed' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (giftCard.status === 'expired') {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'This gift card has expired' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (giftCard.status === 'cancelled') {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'This gift card has been cancelled' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({
        success: true,
        giftCard: {
          code: giftCard.code,
          originalAmount: giftCard.originalAmount,
          balance: giftCard.balance,
          status: giftCard.status,
          expiresAt: giftCard.expiresAt
        }
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=30'
        }
      });
    }
    
    // List all gift cards (admin)
    if (action === 'list') {
      const snapshot = await db.collection('gift-cards')
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();
      
      const giftCards = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      return new Response(JSON.stringify({
        success: true,
        giftCards: giftCards
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=60'
        }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    log.error('[gift-cards] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Create or redeem gift card
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { action } = body;
    
    // Create new gift card (admin or purchase)
    if (action === 'create') {
      const { 
        amount, 
        purchaserEmail, 
        recipientEmail, 
        recipientName,
        message,
        isAdminCreated 
      } = body;
      
      if (!amount || amount < 5 || amount > 500) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Amount must be between £5 and £500' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Generate unique code
      let code = generateGiftCardCode();
      let attempts = 0;
      
      // Ensure code is unique
      while (attempts < 10) {
        const existing = await db.collection('gift-cards')
          .where('code', '==', code)
          .limit(1)
          .get();
        
        if (existing.empty) break;
        code = generateGiftCardCode();
        attempts++;
      }
      
      // Set expiry (1 year from now)
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      
      const giftCard = {
        code: code,
        originalAmount: Number(amount),
        balance: Number(amount),
        status: 'active', // active, used, expired, cancelled
        purchaserEmail: purchaserEmail || null,
        recipientEmail: recipientEmail || null,
        recipientName: recipientName || null,
        message: message || null,
        isAdminCreated: isAdminCreated || false,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        redemptions: []
      };
      
      const docRef = await db.collection('gift-cards').add(giftCard);
      
      log.info('[gift-cards] Created:', code, 'Amount:', amount);
      
      return new Response(JSON.stringify({
        success: true,
        giftCard: {
          id: docRef.id,
          code: code,
          amount: amount,
          expiresAt: expiresAt.toISOString()
        }
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Redeem gift card (at checkout)
    if (action === 'redeem') {
      const { code, amount, orderId, userId } = body;
      
      if (!code || !amount || amount <= 0) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Invalid redemption request' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const snapshot = await db.collection('gift-cards')
        .where('code', '==', code.toUpperCase().trim())
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Invalid gift card code' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const docRef = snapshot.docs[0].ref;
      const giftCard = snapshot.docs[0].data();
      
      if (giftCard.status !== 'active') {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Gift card is not active' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (giftCard.balance < amount) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Insufficient balance on gift card',
          balance: giftCard.balance
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const newBalance = giftCard.balance - amount;
      const redemption = {
        amount: amount,
        orderId: orderId || null,
        userId: userId || null,
        redeemedAt: new Date().toISOString()
      };
      
      await docRef.update({
        balance: newBalance,
        status: newBalance === 0 ? 'used' : 'active',
        redemptions: FieldValue.arrayUnion(redemption),
        lastRedeemedAt: new Date().toISOString()
      });
      
      log.info('[gift-cards] Redeemed:', code, 'Amount:', amount, 'Remaining:', newBalance);
      
      return new Response(JSON.stringify({
        success: true,
        amountRedeemed: amount,
        remainingBalance: newBalance
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Cancel gift card (admin)
    if (action === 'cancel') {
      const { giftCardId } = body;
      
      if (!giftCardId) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Gift card ID is required' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await db.collection('gift-cards').doc(giftCardId).update({
        status: 'cancelled',
        cancelledAt: new Date().toISOString()
      });
      
      log.info('[gift-cards] Cancelled:', giftCardId);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Gift card cancelled'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    log.error('[gift-cards] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};