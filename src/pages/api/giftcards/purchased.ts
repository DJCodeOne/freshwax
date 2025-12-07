// src/pages/api/giftcards/purchased.ts
// Get user's purchased gift cards

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
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Get purchased gift cards from customer's subcollection
    const purchasedSnapshot = await db.collection('customers')
      .doc(userId)
      .collection('purchasedGiftCards')
      .orderBy('purchasedAt', 'desc')
      .get();
    
    const purchasedCards = purchasedSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return new Response(JSON.stringify({
      success: true,
      purchasedCards
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[giftcards/purchased] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch purchased gift cards'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
