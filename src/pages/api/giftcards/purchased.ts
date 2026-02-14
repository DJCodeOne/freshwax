// src/pages/api/giftcards/purchased.ts
// Get user's purchased gift cards - uses Firebase REST API
// SECURITY: Requires authentication - user can only view their own purchased cards
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;


  try {
    // SECURITY: Verify the requesting user's identity
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Get customer document which may contain purchased gift cards
    const customerDoc = await getDocument('users', userId);

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
