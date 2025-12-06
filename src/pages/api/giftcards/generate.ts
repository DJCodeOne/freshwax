// src/pages/api/giftcards/generate.ts
// Generate a new gift card (admin/system use)

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createWelcomeGiftCard, createPromotionalGiftCard } from '../../../lib/giftcard';

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
    const { type, value, description, createdFor, systemKey } = data;
    
    // For security, require a system key for direct API calls
    // This allows registration flow to create cards programmatically
    const validSystemKey = import.meta.env.GIFTCARD_SYSTEM_KEY || 'freshwax-gc-2024';
    
    if (systemKey !== validSystemKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    
    let giftCard;
    
    if (type === 'welcome') {
      giftCard = createWelcomeGiftCard(createdFor);
    } else if (type === 'promotional') {
      if (!value || value <= 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid gift card value'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      giftCard = createPromotionalGiftCard(value, description || `£${value} Gift Card`, createdFor);
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid gift card type'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Check code doesn't already exist (extremely unlikely but safe)
    const existing = await db.collection('giftCards')
      .where('code', '==', giftCard.code)
      .get();
    
    if (!existing.empty) {
      // Regenerate code
      const { generateGiftCardCode } = await import('../../../lib/giftcard');
      giftCard.code = generateGiftCardCode();
    }
    
    // Save to Firestore
    const docRef = await db.collection('giftCards').add(giftCard);
    
    console.log('[giftcards/generate] Created gift card:', giftCard.code, 'type:', type, 'value:', giftCard.originalValue);
    
    return new Response(JSON.stringify({
      success: true,
      giftCard: {
        id: docRef.id,
        code: giftCard.code,
        value: giftCard.originalValue,
        type: giftCard.type,
        description: giftCard.description,
        expiresAt: giftCard.expiresAt
      }
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[giftcards/generate] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate gift card'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
