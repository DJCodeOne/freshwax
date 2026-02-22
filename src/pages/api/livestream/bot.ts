// src/pages/api/livestream/bot.ts
// Bot API - Send announcements and scheduled messages
// POST /api/livestream/bot/ - Send a bot message to a stream

import type { APIRoute } from 'astro';
import { addDocument, getDocument, queryCollection } from '../../../lib/firebase-rest';
import { BOT_USER, BOT_ANNOUNCEMENTS } from '../../../lib/chatbot';
import { getAdminUids, initAdminEnv, requireAdminAuth } from '../../../lib/admin';
import { triggerPusher } from '../../../lib/pusher';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('livestream/bot');

// Send bot message to a stream
async function sendBotMessage(streamId: string, message: string, env: Record<string, unknown>): Promise<{ success: boolean; messageId?: string }> {
  const now = new Date().toISOString();

  const botMessage = {
    streamId,
    userId: BOT_USER.id,
    userName: BOT_USER.name,
    userAvatar: BOT_USER.avatar,
    message,
    type: 'bot',
    badge: BOT_USER.badge,
    isModerated: false,
    createdAt: now
  };

  // Save to Firestore
  const { id: messageId } = await addDocument('livestream-chat', botMessage);

  // Broadcast via Pusher
  const pusherSuccess = await triggerPusher(`stream-${streamId}`, 'new-message', {
    id: messageId,
    ...botMessage
  }, env);

  return { success: pusherSuccess, messageId };
}

// POST: Send a bot message or announcement
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`livestream-bot:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  try {
    const data = await request.json();
    const { streamId, message, announcement, adminId } = data;

    // SECURITY: Verify admin via proper auth — never trust client-submitted adminId
    // For internal/system calls, adminId='system' is allowed with server key
    if (adminId === 'system') {
      // System calls must provide server key
      const serverKey = request.headers.get('x-server-key');
      const expectedKey = env?.STREAM_SERVER_KEY || import.meta.env.STREAM_SERVER_KEY;
      if (!expectedKey || !serverKey || serverKey !== expectedKey) {
        return ApiErrors.forbidden('Unauthorized');
      }
    } else {
      // Human admin calls must pass requireAdminAuth
      const authError = await requireAdminAuth(request, locals, data);
      if (authError) return authError;
    }

    if (!streamId) {
      return ApiErrors.badRequest('Stream ID is required');
    }

    let messageText = message;

    // Handle pre-defined announcements
    if (announcement) {
      switch (announcement) {
        case 'welcome':
          const stream = await getDocument('livestreamSlots', streamId);
          messageText = BOT_ANNOUNCEMENTS.welcome(stream?.djName || 'DJ');
          break;
        case 'nextDj':
          messageText = BOT_ANNOUNCEMENTS.nextDj(data.djName || 'Next DJ', data.minutes || 5);
          break;
        case 'streamEnding':
          messageText = BOT_ANNOUNCEMENTS.streamEnding();
          break;
        case 'milestone':
          messageText = BOT_ANNOUNCEMENTS.milestone(data.viewers || 100);
          break;
        default:
          return ApiErrors.badRequest('Unknown announcement type');
      }
    }

    if (!messageText) {
      return ApiErrors.badRequest('Message or announcement type is required');
    }

    const result = await sendBotMessage(streamId, messageText, env);

    return jsonResponse({
      success: result.success,
      messageId: result.messageId
    });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to send bot message');
  }
};

// GET: Check for streams that need announcements (for scheduled jobs)
export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId2 = getClientId(request);
  const rateLimit2 = checkRateLimit(`livestream-bot-check:${clientId2}`, RateLimiters.standard);
  if (!rateLimit2.allowed) {
    return rateLimitResponse(rateLimit2.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'check-upcoming') {
      // Find streams starting in the next 5 minutes
      const now = new Date();
      const fiveMinutesLater = new Date(now.getTime() + 5 * 60 * 1000);

      const upcomingSlots = await queryCollection('livestreamSlots', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'scheduled' },
          { field: 'scheduledFor', op: 'GREATER_THAN', value: now.toISOString() },
          { field: 'scheduledFor', op: 'LESS_THAN_OR_EQUAL', value: fiveMinutesLater.toISOString() }
        ],
        limit: 5
      });

      return successResponse({ upcoming: upcomingSlots.map(slot => ({
          id: slot.id,
          djName: slot.djName,
          scheduledFor: slot.scheduledFor,
          title: slot.title
        })) });
    }

    // Default: return bot info
    return successResponse({ bot: BOT_USER,
      commands: ['!help', '!dj', '!schedule', '!next', '!rules'],
      announcements: Object.keys(BOT_ANNOUNCEMENTS) });

  } catch (error: unknown) {
    log.error('GET Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get bot info');
  }
};
