// src/pages/api/livestream/chat.ts
// Live stream chat - send messages, get recent messages
// Uses Pusher for real-time delivery (reduces Firebase reads)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { BOT_USER, isBotCommand, processBotCommand, getRandomTuneComment, getWelcomeMessage, shouldCommentOnTune, shouldWelcomeUser } from '../../../lib/chatbot';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { isAdmin } from '../../../lib/admin';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { simpleMd5 } from '../../../lib/pusher';
const log = createLogger('[livestream/chat]');

const LivestreamChatSchema = z.object({
  streamId: z.string().min(1).max(500),
  userName: z.string().max(200).nullish(),
  userAvatar: z.string().max(2000).nullish(),
  isPro: z.boolean().nullish(),
  badge: z.string().max(50).nullish(),
  message: z.string().min(1).max(2000),
  type: z.string().max(50).nullish(),
  giphyUrl: z.string().max(2000).nullish(),
  giphyId: z.string().max(500).nullish(),
  replyTo: z.string().max(500).nullish(),
  replyToUserName: z.string().max(200).nullish(),
  replyToPreview: z.string().max(500).nullish(),
}).strip();

// ============================================
// CONTENT MODERATION
// ============================================

// Common profanity list (lowercase) - catches most variations
// Words marked with _exact require exact word match (not substring)
const PROFANITY_EXACT = [
  // Short words that could be substrings of legitimate words
  'ass', 'arse', 'fag', 'piss', 'cock', 'dick', 'cum', 'tit', 'fuk',
];

const PROFANITY_SUBSTRING = [
  // Longer words safe to check as substrings
  'fuck', 'fucker', 'fucking', 'fuckin', 'motherfuck',
  'shit', 'shite', 'shitty', 'bullshit',
  'cunt',
  'bitch', 'bitches',
  'bastard',
  'asshole', 'arsehole',
  'dickhead',
  'wanker', 'wank',
  'twat',
  'slut', 'whore',
  'nigger', 'nigga',
  'faggot',
  'retard', 'retarded',
  // Spam/scam keywords
  'scam', 'free money', 'click here', 'buy now',
  // Drug references
  'cocaine', 'heroin',
];

// Normalize text for comparison (handle leetspeak and symbol substitutions)
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/\!/g, 'i')
    .replace(/\*/g, '')
    .replace(/[_\-\.]/g, '');
}

// Check if message contains profanity
function containsProfanity(message: string): boolean {
  const normalized = normalizeText(message);
  const words = normalized.split(/\s+/);

  // Check exact word matches (for short words that could be substrings)
  for (const word of words) {
    if (PROFANITY_EXACT.includes(word)) {
      return true;
    }
  }

  // Check substring matches (for longer, distinct profanity)
  for (const profane of PROFANITY_SUBSTRING) {
    if (normalized.includes(profane)) {
      return true;
    }
  }

  return false;
}

// Check for spam patterns
function isSpamMessage(message: string): { isSpam: boolean; reason?: string } {
  // Check for excessive caps (more than 70% uppercase and length > 10)
  if (message.length > 10) {
    const upperCount = (message.match(/[A-Z]/g) || []).length;
    const letterCount = (message.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && upperCount / letterCount > 0.7) {
      return { isSpam: true, reason: 'Please turn off caps lock' };
    }
  }

  // Check for repeated characters (aaaaaaa, !!!!!!!)
  if (/(.)\1{5,}/.test(message)) {
    return { isSpam: true, reason: 'Message contains too many repeated characters' };
  }

  // Check for repeated words (hello hello hello hello)
  const words = message.toLowerCase().split(/\s+/);
  if (words.length >= 4) {
    const wordCounts: Record<string, number> = {};
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
      if (wordCounts[word] >= 4) {
        return { isSpam: true, reason: 'Message contains too many repeated words' };
      }
    }
  }

  // Check for URLs (except common music platforms which are allowed in moderation)
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urls = message.match(urlPattern) || [];
  for (const url of urls) {
    const lowerUrl = url.toLowerCase();
    // Allow certain music/video platforms
    const allowedDomains = ['youtube.com', 'youtu.be', 'soundcloud.com', 'vimeo.com', 'mixcloud.com', 'spotify.com'];
    const isAllowed = allowedDomains.some(domain => lowerUrl.includes(domain));
    if (!isAllowed) {
      return { isSpam: true, reason: 'Links are not allowed in chat' };
    }
  }

  return { isSpam: false };
}

// Main moderation function
function moderateMessage(message: string): { allowed: boolean; reason?: string } {
  // Trim and check minimum length
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: 'Message cannot be empty' };
  }

  // Check for profanity
  if (containsProfanity(trimmed)) {
    return { allowed: false, reason: 'Please keep the chat friendly and respectful' };
  }

  // Check for spam
  const spamCheck = isSpamMessage(trimmed);
  if (spamCheck.isSpam) {
    return { allowed: false, reason: spamCheck.reason };
  }

  return { allowed: true };
}

// Web Crypto API helper for HMAC-SHA256 (hex output)
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBuffer = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Trigger Pusher event using Web Crypto API
async function triggerPusher(channel: string, event: string, data: Record<string, unknown>, env?: Record<string, unknown>): Promise<boolean> {
  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
    log.error('[Pusher] Missing configuration - cannot broadcast chat');
    return false;
  }

  try {
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });

    const bodyMd5 = simpleMd5(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const params = new URLSearchParams({
      auth_key: PUSHER_KEY,
      auth_timestamp: timestamp,
      auth_version: '1.0',
      body_md5: bodyMd5
    });
    params.sort();

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\n${params.toString()}`;
    const signature = await hmacSha256Hex(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?${params.toString()}&auth_signature=${signature}`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    if (!response.ok) {
      log.error('[Pusher] Failed:', response.status, await response.text());
      return false;
    }

    return true;
  } catch (error: unknown) {
    log.error('[Pusher] Error:', error);
    return false;
  }
}

// Get recent chat messages (initial load only - no real-time)
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const after = url.searchParams.get('after'); // For pagination
    
    if (!streamId) {
      return ApiErrors.badRequest('Stream ID is required');
    }
    
    // Note: firebase-rest doesn't support startAfter, so we'll skip pagination for now
    // When streamId is 'playlist-global' (no live stream), show recent messages from any stream
    // This allows chat to persist between streams as a general chat area
    const isGlobalMode = streamId === 'playlist-global';

    let messages: Record<string, unknown>[];

    if (isGlobalMode) {
      // For global mode, fetch recent messages without the composite filter
      // (avoids needing a new Firestore index) and filter client-side
      const allMessages = await queryCollection('livestream-chat', {
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: limit * 2 // Fetch extra to account for filtering
      });
      messages = allMessages
        .filter((msg: Record<string, unknown>) => !msg.isModerated)
        .slice(0, limit);
    } else {
      messages = await queryCollection('livestream-chat', {
        filters: [
          { field: 'streamId', op: 'EQUAL', value: streamId },
          { field: 'isModerated', op: 'EQUAL', value: false }
        ],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit
      });
    }

    // Reverse to get chronological order
    messages.reverse();
    
    return successResponse({ messages }, 200, { headers: { 'Cache-Control': 'no-cache' } });
    
  } catch (error: unknown) {
    log.error('[livestream/chat] GET Error:', error);
    return ApiErrors.serverError('Failed to get messages');
  }
};

// Send a chat message
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: chat messages - 30 per minute per IP
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`livestream-chat:${clientId}`, RateLimiters.chat);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals?.runtime?.env;

  // Verify authenticated user
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    const rawBody = await request.json();
    const parseResult = LivestreamChatSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { streamId, userName, userAvatar, isPro, badge, message, type, giphyUrl, giphyId, replyTo, replyToUserName, replyToPreview } = parseResult.data;
    // Use verified userId from token, not from body
    const userId = authUserId;
    
    // Special case: playlist-global is always allowed for DJ waitlist chat
    const isPlaylistMode = streamId === 'playlist-global';

    if (!isPlaylistMode) {
      // Verify stream exists and is live
      // Check both livestreamSlots (new system) and livestreams (legacy)
      let streamDoc = await getDocument('livestreamSlots', streamId);
      let isStreamLive = streamDoc?.status === 'live';

      // Fall back to legacy livestreams collection
      if (!streamDoc) {
        streamDoc = await getDocument('livestreams', streamId);
        isStreamLive = streamDoc?.isLive === true;
      }

      if (!streamDoc || !isStreamLive) {
        return ApiErrors.badRequest('Stream is not live');
      }
    }
    
    // Content moderation - profanity filter and spam detection
    if (type !== 'giphy') {
      const moderationResult = moderateMessage(message);
      if (!moderationResult.allowed) {
        return ApiErrors.badRequest(moderationResult.reason);
      }
    }
    
    // Rate limiting - max 1 message per second per user (skip if query fails)
    try {
      const recentMessages = await queryCollection('livestream-chat', {
        filters: [
          { field: 'streamId', op: 'EQUAL', value: streamId },
          { field: 'userId', op: 'EQUAL', value: userId }
        ],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 1
      });

      if (recentMessages.length > 0) {
        const lastMessage = recentMessages[0];
        const timeSince = Date.now() - new Date(lastMessage.createdAt).getTime();
        if (timeSince < 1000) {
          return ApiErrors.tooManyRequests('Slow down! Wait a moment before sending another message.');
        }
      }
    } catch (rateLimitError: unknown) {
      // Skip rate limiting if query fails (missing index)
      log.warn('[chat] Rate limit check failed:', rateLimitError);
    }
    
    const now = new Date().toISOString();
    
    const chatMessage = {
      streamId,
      userId,
      userName: userName || 'Anonymous',
      userAvatar: userAvatar || null,
      isPro: isPro === true, // Plus member status for badge display
      badge: badge || 'crown', // User's selected Plus badge (default: crown)
      message: message.substring(0, 500), // Limit message length
      type: type || 'text',
      giphyUrl: giphyUrl || null,
      giphyId: giphyId || null,
      replyTo: replyTo || null,
      replyToUserName: replyToUserName || null,
      replyToPreview: replyToPreview || null,
      isModerated: false,
      createdAt: now
    };
    
    const { id: messageId } = await addDocument('livestream-chat', chatMessage);

    // Trigger Pusher for real-time delivery to all connected clients
    // This replaces Firebase onSnapshot - no more reads per client!
    const chatChannel = `stream-${streamId}`;
    const pusherSuccess = await triggerPusher(chatChannel, 'new-message', {
      id: messageId,
      ...chatMessage
    }, env);

    // Check if this is a bot command and send bot response
    let botResponse = null;
    if (isBotCommand(message)) {
      try {
        const responseText = await processBotCommand(message, streamId, env);
        if (responseText) {
          const botNow = new Date().toISOString();
          const botMessage = {
            streamId,
            userId: BOT_USER.id,
            userName: BOT_USER.name,
            userAvatar: BOT_USER.avatar,
            message: responseText,
            type: 'bot',
            badge: BOT_USER.badge,
            isModerated: false,
            createdAt: botNow
          };

          // Save bot message to Firestore
          const { id: botMessageId } = await addDocument('livestream-chat', botMessage);

          // Broadcast bot message via Pusher
          await triggerPusher(chatChannel, 'new-message', {
            id: botMessageId,
            ...botMessage
          }, env);

          botResponse = {
            id: botMessageId,
            ...botMessage
          };
        }
      } catch (botError: unknown) {
        log.error('[chat] Bot command error:', botError);
      }
    }

    // Interactive bot features - use waitUntil to ensure async operations complete
    if (!isBotCommand(message) && type !== 'bot') {
      const interactiveBotTask = (async () => {
        try {
          // Query for previous messages from this user in this stream
          const previousMessages = await queryCollection('livestream-chat', {
            filters: [
              { field: 'streamId', op: 'EQUAL', value: streamId },
              { field: 'userId', op: 'EQUAL', value: userId }
            ],
            limit: 2
          });

          // If this is their first message (only 1 result = the one we just sent)
          const isNewUser = previousMessages.length <= 1;

          if (isNewUser && shouldWelcomeUser()) {
            // Small delay so welcome appears after their message
            await new Promise(resolve => setTimeout(resolve, 1500));

            const welcomeText = getWelcomeMessage(userName || 'friend');
            const welcomeNow = new Date().toISOString();
            const welcomeMessage = {
              streamId,
              userId: BOT_USER.id,
              userName: BOT_USER.name,
              userAvatar: BOT_USER.avatar,
              message: welcomeText,
              type: 'bot',
              badge: BOT_USER.badge,
              isModerated: false,
              createdAt: welcomeNow
            };

            const { id: welcomeId } = await addDocument('livestream-chat', welcomeMessage);
            await triggerPusher(chatChannel, 'new-message', {
              id: welcomeId,
              ...welcomeMessage
            }, env);
          }
          // Random chance to comment on a tune (only for non-new users to avoid spam)
          else if (!isNewUser && shouldCommentOnTune()) {
            // Shorter delay for tune comments (1-3 seconds)
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

            const tuneComment = getRandomTuneComment();
            const tuneNow = new Date().toISOString();
            const tuneMessage = {
              streamId,
              userId: BOT_USER.id,
              userName: BOT_USER.name,
              userAvatar: BOT_USER.avatar,
              message: tuneComment,
              type: 'bot',
              badge: BOT_USER.badge,
              isModerated: false,
              createdAt: tuneNow
            };

            const { id: tuneId } = await addDocument('livestream-chat', tuneMessage);
            await triggerPusher(chatChannel, 'new-message', {
              id: tuneId,
              ...tuneMessage
            }, env);
          }
        } catch (interactiveError: unknown) {
          // Silent fail - don't break the chat for interactive features
          log.error('[chat] Interactive bot error:', interactiveError);
        }
      })();

      // Use Cloudflare's waitUntil to keep worker alive for async bot operations
      const ctx = locals.runtime.ctx;
      if (ctx?.waitUntil) {
        ctx.waitUntil(interactiveBotTask);
      }
    }

    return successResponse({ pusherSuccess,
      message: {
        id: messageId,
        ...chatMessage
      },
      botResponse });

  } catch (error: unknown) {
    log.error('[livestream/chat] POST Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to send message');
  }
};

// Delete a message (for moderation)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Verify authenticated user
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    const url = new URL(request.url);
    const messageId = url.searchParams.get('messageId');

    if (!messageId) {
      return ApiErrors.badRequest('Message ID is required');
    }

    // Check if the verified user is admin or owns the message
    const chatMessage = await getDocument('livestream-chat', messageId);
    const userIsAdmin = await isAdmin(authUserId);

    if (!userIsAdmin && chatMessage?.userId !== authUserId) {
      return ApiErrors.forbidden('Not authorized to delete this message');
    }

    // Mark as moderated rather than delete
    await updateDocument('livestream-chat', messageId, {
      isModerated: true,
      moderatedBy: authUserId,
      moderatedAt: new Date().toISOString()
    });

    return successResponse({ message: 'Message removed' });

  } catch (error: unknown) {
    log.error('[livestream/chat] DELETE Error:', error);
    return ApiErrors.serverError('Failed to delete message');
  }
};
