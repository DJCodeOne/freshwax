// src/pages/api/dj-lobby/chat-cleanup.ts
// DJ Lobby chat cleanup - check and clean up old chat messages, record stream end times
import type { APIRoute } from 'astro';
import { getDocument, setDocument, deleteDocument, queryCollection, verifyUserToken } from '../../../lib/firebase-rest';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

// Check if user has DJ or admin role
async function isDjOrAdmin(userId: string): Promise<boolean> {
  try {
    // Check admin collection
    const adminDoc = await getDocument('admins', userId);
    if (adminDoc) return true;

    // Check user roles
    const userDoc = await getDocument('users', userId);
    if (userDoc?.roles?.dj || userDoc?.roles?.djEligible || userDoc?.roles?.artist) return true;

    return false;
  } catch {
    return false;
  }
}

// POST: Check and cleanup chat, or record stream end
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

    // Only DJs and admins can manage chat cleanup
    if (!(await isDjOrAdmin(userId))) {
      return ApiErrors.forbidden('DJ or admin access required');
    }

    const data = await request.json();
    const { action } = data;

    switch (action) {
      case 'check-and-cleanup': {
        // Check if chat should be cleaned up (2 hours since last stream ended)
        const settings = await getDocument('djLobbySettings', 'chatCleanup');

        if (!settings) {
          return new Response(JSON.stringify({
            success: true,
            cleaned: false,
            reason: 'no-settings'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const lastStreamEndTime = settings.lastStreamEndTime
          ? new Date(settings.lastStreamEndTime).getTime()
          : 0;
        const now = Date.now();
        const twoHoursMs = 2 * 60 * 60 * 1000;
        const isCurrentlyLive = data.isCurrentlyLive || false;

        if (isCurrentlyLive || lastStreamEndTime === 0 || (now - lastStreamEndTime) <= twoHoursMs) {
          return new Response(JSON.stringify({
            success: true,
            cleaned: false,
            reason: isCurrentlyLive ? 'currently-live' : 'too-recent'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        // Delete all DJ lobby chat messages
        const chatMessages = await queryCollection('djLobbyChat', { limit: 500 });
        const deletePromises = chatMessages.map(msg =>
          deleteDocument('djLobbyChat', msg.id)
        );
        await Promise.all(deletePromises);

        // Reset the lastStreamEndTime so we don't keep deleting
        await setDocument('djLobbySettings', 'chatCleanup', {
          lastStreamEndTime: null,
          lastCleanup: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          cleaned: true,
          messagesDeleted: chatMessages.length
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'record-stream-end': {
        // Record that a stream has ended (for timed cleanup)
        await setDocument('djLobbySettings', 'chatCleanup', {
          lastStreamEndTime: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Stream end recorded'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      default:
        return ApiErrors.badRequest('Invalid action. Use check-and-cleanup or record-stream-end');
    }

  } catch (error: unknown) {
    console.error('[dj-lobby/chat-cleanup] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
