// src/pages/api/giftcards/generate.ts
// Generate a new gift card (admin/system use)

import type { APIRoute } from 'astro';
import { getDocument, addDocument, queryCollection } from '../../../lib/firebase-rest';
import { createWelcomeGiftCard, createPromotionalGiftCard } from '../../../lib/giftcard';

// Timing-safe string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Do constant-time work against b to prevent length leakage via timing
    let result = 0;
    for (let i = 0; i < b.length; i++) {
      result |= a.charCodeAt(i % a.length) ^ b.charCodeAt(i);
    }
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  try {
    const data = await request.json();
    const { type, value, description, createdFor, systemKey } = data;

    // For security, require a system key for direct API calls
    // This allows registration flow to create cards programmatically
    const validSystemKey = env?.GIFTCARD_SYSTEM_KEY || import.meta.env.GIFTCARD_SYSTEM_KEY;

    // SECURITY: No fallback key - must be configured in environment
    if (!validSystemKey) {
      console.error('[giftcards/generate] GIFTCARD_SYSTEM_KEY not configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'Gift card system not configured'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // SECURITY: Use proper timing-safe comparison to prevent timing attacks
    if (!systemKey || !timingSafeEqual(validSystemKey, systemKey)) {
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
    const existing = await queryCollection('giftCards', {
      filters: [{ field: 'code', op: 'EQUAL', value: giftCard.code }],
      limit: 1
    });

    if (existing.length > 0) {
      // Regenerate code
      const { generateGiftCardCode } = await import('../../../lib/giftcard');
      giftCard.code = generateGiftCardCode();
    }

    // Save to Firestore
    const result = await addDocument('giftCards', giftCard);

    console.log('[giftcards/generate] Created gift card:', giftCard.code, 'type:', type, 'value:', giftCard.originalValue);

    return new Response(JSON.stringify({
      success: true,
      giftCard: {
        id: result.id,
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
