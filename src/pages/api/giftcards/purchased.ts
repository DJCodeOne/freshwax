// src/pages/api/giftcards/purchased.ts
// Get user's purchased gift cards - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';

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

    // Get customer document which may contain purchased gift cards
    const customerDoc = await getDocument('customers', userId);

    // The subcollection approach doesn't work with REST API directly,
    // so we'll check if purchased cards are stored on the customer doc
    const purchasedCards = customerDoc?.purchasedGiftCards || [];

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
