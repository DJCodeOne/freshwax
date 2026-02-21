// src/pages/api/giftcards/generate.ts
// Generate a new gift card (admin/system use)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, addDocument, queryCollection } from '../../../lib/firebase-rest';
import { createWelcomeGiftCard, createPromotionalGiftCard } from '../../../lib/giftcard';
import { createLogger, errorResponse, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[giftcards/generate]');

// Zod schema for gift card generation
const GenerateGiftCardSchema = z.object({
  type: z.enum(['welcome', 'promotional']),
  value: z.number().positive().optional(),
  description: z.string().max(500).optional(),
  createdFor: z.string().optional(),
  systemKey: z.string().min(1, 'System key required'),
}).passthrough();

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
    const rawBody = await request.json();

    const parseResult = GenerateGiftCardSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { type, value, description, createdFor, systemKey } = parseResult.data;

    // For security, require a system key for direct API calls
    const validSystemKey = env?.GIFTCARD_SYSTEM_KEY || import.meta.env.GIFTCARD_SYSTEM_KEY;

    // SECURITY: No fallback key - must be configured in environment
    if (!validSystemKey) {
      log.error('GIFTCARD_SYSTEM_KEY not configured');
      return errorResponse('Gift card system not configured', 503);
    }

    // SECURITY: Use proper timing-safe comparison to prevent timing attacks
    if (!timingSafeEqual(validSystemKey, systemKey)) {
      return ApiErrors.unauthorized('Unauthorized');
    }

    let giftCard;

    if (type === 'welcome') {
      giftCard = createWelcomeGiftCard(createdFor);
    } else {
      // type === 'promotional' (validated by Zod enum)
      if (!value || value <= 0) {
        return ApiErrors.badRequest('Invalid gift card value');
      }
      giftCard = createPromotionalGiftCard(value, description || `£${value} Gift Card`, createdFor);
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

    log.info('Created gift card:', giftCard.code, 'type:', type, 'value:', giftCard.originalValue);

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

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to generate gift card');
  }
};
