// src/pages/api/livestream/chat.ts
// Live stream chat - send messages, get recent messages
// Uses Pusher for real-time delivery (reduces Firebase reads)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { BOT_USER, isBotCommand, processBotCommand, getRandomTuneComment, getWelcomeMessage, shouldCommentOnTune, shouldWelcomeUser } from '../../../lib/chatbot';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

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

// Helper to initialize Firebase and return env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  return env;
}

// Simple MD5 implementation for Cloudflare Workers
// Converts string to UTF-8 bytes first to handle unicode/emojis properly
function simpleMd5(str: string): string {
  // Convert string to UTF-8 bytes to handle unicode/emojis
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  // Convert bytes back to a latin1 string for the MD5 algorithm
  let latin1 = '';
  for (let i = 0; i < bytes.length; i++) {
    latin1 += String.fromCharCode(bytes[i]);
  }
  str = latin1;

  function md5cycle(x: number[], k: number[]) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(c ^ (b | (~d)), a, b, x, s, t);
  }
  function add32(a: number, b: number) {
    return (a + b) & 0xFFFFFFFF;
  }
  function md5blk(s: string) {
    const md5blks: number[] = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
  function rhex(n: number) {
    const hex_chr = '0123456789abcdef';
    let s = '';
    for (let j = 0; j < 4; j++) {
      s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0F) + hex_chr.charAt((n >> (j * 8)) & 0x0F);
    }
    return s;
  }
  function hex(x: number[]) {
    return rhex(x[0]) + rhex(x[1]) + rhex(x[2]) + rhex(x[3]);
  }
  function md5(s: string) {
    const n = s.length;
    let state = [1732584193, -271733879, -1732584194, 271733878];
    let i: number;
    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) {
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  return hex(md5(str));
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
async function triggerPusher(channel: string, event: string, data: any, env?: any): Promise<boolean> {
  console.log('[DEBUG chat.ts] triggerPusher called:', { channel, event });

  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  console.log('[DEBUG chat.ts] Pusher config:', {
    hasAppId: !!PUSHER_APP_ID,
    hasKey: !!PUSHER_KEY,
    hasSecret: !!PUSHER_SECRET,
    cluster: PUSHER_CLUSTER
  });

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
    console.error('[Pusher] Missing configuration - cannot broadcast chat');
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    if (!response.ok) {
      console.error('[Pusher] Failed:', response.status, await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Pusher] Error:', error);
    return false;
  }
}

// Get recent chat messages (initial load only - no real-time)
export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const after = url.searchParams.get('after'); // For pagination
    
    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Note: firebase-rest doesn't support startAfter, so we'll skip pagination for now
    const messages = await queryCollection('livestream-chat', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId },
        { field: 'isModerated', op: 'EQUAL', value: false }
      ],
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit
    });

    // Reverse to get chronological order
    messages.reverse();
    
    return new Response(JSON.stringify({
      success: true,
      messages
    }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      } 
    });
    
  } catch (error) {
    console.error('[livestream/chat] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get messages'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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

  // Initialize Firebase for Cloudflare runtime and get env for Pusher
  const env = initFirebase(locals);

  try {
    const data = await request.json();
    const { streamId, userId, userName, userAvatar, isPro, badge, message, type, giphyUrl, giphyId, replyTo, replyToUserName, replyToPreview } = data;
    
    if (!streamId || !userId || !message) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Stream is not live'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    // Content moderation - profanity filter and spam detection
    if (type !== 'giphy') {
      const moderationResult = moderateMessage(message);
      if (!moderationResult.allowed) {
        return new Response(JSON.stringify({
          success: false,
          error: moderationResult.reason
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
          return new Response(JSON.stringify({
            success: false,
            error: 'Slow down! Wait a moment before sending another message.'
          }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
      }
    } catch (rateLimitError) {
      // Skip rate limiting if query fails (missing index)
      console.warn('[chat] Rate limit check failed:', rateLimitError);
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
    console.log('[chat.ts] Broadcasting message to channel:', chatChannel);
    const pusherSuccess = await triggerPusher(chatChannel, 'new-message', {
      id: messageId,
      ...chatMessage
    }, env);
    console.log('[chat.ts] Pusher broadcast result:', pusherSuccess);

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
      } catch (botError) {
        console.error('[chat] Bot command error:', botError);
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
            console.log('[chat] Bot welcomed new user:', userName);
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
            console.log('[chat] Bot tune comment:', tuneComment);
          }
        } catch (interactiveError) {
          // Silent fail - don't break the chat for interactive features
          console.error('[chat] Interactive bot error:', interactiveError);
        }
      })();

      // Use Cloudflare's waitUntil to keep worker alive for async bot operations
      const ctx = (locals as any)?.runtime?.ctx;
      if (ctx?.waitUntil) {
        ctx.waitUntil(interactiveBotTask);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      pusherSuccess,
      message: {
        id: messageId,
        ...chatMessage
      },
      botResponse
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[livestream/chat] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send message',
      details: error?.message || String(error)
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Delete a message (for moderation)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const messageId = url.searchParams.get('messageId');
    const moderatorId = url.searchParams.get('moderatorId');
    
    if (!messageId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Mark as moderated rather than delete
    await updateDocument('livestream-chat', messageId, {
      isModerated: true,
      moderatedBy: moderatorId || 'system',
      moderatedAt: new Date().toISOString()
    });
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Message removed'
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[livestream/chat] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete message'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
