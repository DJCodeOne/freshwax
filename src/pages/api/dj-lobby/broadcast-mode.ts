// src/pages/api/dj-lobby/broadcast-mode.ts
// Update livestream slot broadcast mode (placeholder vs video)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, verifyUserToken, getDocument } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('dj-lobby/broadcast-mode');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const BroadcastModeSchema = z.object({
  slotId: z.string().min(1).max(500),
  mode: z.enum(['placeholder', 'video']),
  hlsUrl: z.string().max(2000).nullish(),
}).passthrough();

export const prerender = false;

// POST: Update broadcast mode for a livestream slot
export const POST: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`broadcast-mode:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const userId = await verifyUserToken(idToken);
    if (!userId) {
      return ApiErrors.forbidden('Invalid token');
    }

    const rawBody = await request.json();
    const parseResult = BroadcastModeSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request. Slot ID required and mode must be placeholder or video');
    }
    const { slotId, mode, hlsUrl } = parseResult.data;

    // Verify the user owns this slot
    const slot = await getDocument('livestreamSlots', slotId);
    if (!slot) {
      return ApiErrors.notFound('Slot not found');
    }
    if (slot.djId !== userId) {
      return ApiErrors.forbidden('You can only update your own stream slot');
    }

    // Update the slot
    await updateDocument('livestreamSlots', slotId, {
      broadcastMode: mode,
      hlsUrl: hlsUrl || null,
      updatedAt: new Date().toISOString()
    });

    return successResponse({ message: 'Broadcast mode updated',
      mode,
      hlsUrl });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update broadcast mode');
  }
};
