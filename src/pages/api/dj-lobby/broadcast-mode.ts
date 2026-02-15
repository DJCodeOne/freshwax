// src/pages/api/dj-lobby/broadcast-mode.ts
// Update livestream slot broadcast mode (placeholder vs video)
import type { APIRoute } from 'astro';
import { updateDocument, verifyUserToken, getDocument } from '../../../lib/firebase-rest';

export const prerender = false;

// POST: Update broadcast mode for a livestream slot
export const POST: APIRoute = async ({ request }) => {
  try {
    // Verify authentication
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    if (!idToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const userId = await verifyUserToken(idToken);
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid token'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await request.json();
    const { slotId, mode, hlsUrl } = data;

    if (!slotId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Slot ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!mode || !['placeholder', 'video'].includes(mode)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid mode. Use placeholder or video'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the user owns this slot
    const slot = await getDocument('livestreamSlots', slotId);
    if (!slot) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Slot not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (slot.djId !== userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only update your own stream slot'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
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
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update broadcast mode'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
