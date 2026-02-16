// src/pages/api/dj-lobby/broadcast-mode.ts
// Update livestream slot broadcast mode (placeholder vs video)
import type { APIRoute } from 'astro';
import { updateDocument, verifyUserToken, getDocument } from '../../../lib/firebase-rest';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

// POST: Update broadcast mode for a livestream slot
export const POST: APIRoute = async ({ request }) => {
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

    const data = await request.json();
    const { slotId, mode, hlsUrl } = data;

    if (!slotId) {
      return ApiErrors.badRequest('Slot ID required');
    }

    if (!mode || !['placeholder', 'video'].includes(mode)) {
      return ApiErrors.badRequest('Invalid mode. Use placeholder or video');
    }

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

    return new Response(JSON.stringify({
      success: true,
      message: 'Broadcast mode updated',
      mode,
      hlsUrl
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[dj-lobby/broadcast-mode] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update broadcast mode');
  }
};
