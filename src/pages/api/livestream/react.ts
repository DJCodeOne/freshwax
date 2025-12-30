// src/pages/api/livestream/react.ts
// Live stream reactions - likes, ratings, viewer tracking, emoji broadcasts
// Uses Pusher for real-time emoji delivery
// Uses Web Crypto API for Cloudflare Workers compatibility

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, incrementField, initFirebaseEnv } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

// Helper to initialize Firebase and return env for Pusher
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  return env;
}

// Helper to get stream document from either collection (livestreamSlots or livestreams)
async function getStreamDocument(streamId: string) {
  // Try livestreamSlots first (new system)
  let doc = await getDocument('livestreamSlots', streamId);
  if (doc) return { doc, collection: 'livestreamSlots' };

  // Fall back to livestreams (legacy)
  doc = await getDocument('livestreams', streamId);
  if (doc) return { doc, collection: 'livestreams' };

  return { doc: null, collection: 'livestreamSlots' };
}

// Simple MD5 hash for Cloudflare Workers (Pusher requires MD5 for body hash)
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

  // MD5 algorithm implementation
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
  function md51(s: string) {
    const n = s.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    const tail = new Array(16).fill(0);
    for (i = 0; i < s.length; i++) {
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      tail.fill(0);
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function md5blk(s: string) {
    const md5blks = new Array(16);
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
  function rhex(n: number) {
    const hex_chr = '0123456789abcdef';
    let s = '';
    for (let j = 0; j < 4; j++) {
      s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0f) + hex_chr.charAt((n >> (j * 8)) & 0x0f);
    }
    return s;
  }
  function add32(a: number, b: number) {
    return (a + b) & 0xffffffff;
  }
  const x = md51(str);
  return rhex(x[0]) + rhex(x[1]) + rhex(x[2]) + rhex(x[3]);
}

// HMAC-SHA256 using Web Crypto API
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
  console.log('[DEBUG] triggerPusher called:', { channel, event, data });

  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  console.log('[DEBUG] Pusher config:', {
    hasAppId: !!PUSHER_APP_ID,
    appIdLength: PUSHER_APP_ID?.length || 0,
    hasKey: !!PUSHER_KEY,
    keyPrefix: PUSHER_KEY?.substring(0, 8) || '',
    hasSecret: !!PUSHER_SECRET,
    secretLength: PUSHER_SECRET?.length || 0,
    cluster: PUSHER_CLUSTER
  });

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
    console.error('[Pusher] Missing configuration - cannot broadcast');
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

export const POST: APIRoute = async ({ request, locals }) => {
  const env = initFirebase(locals);
  const clientId = getClientId(request);

  try {
    const data = await request.json();
    const { action, streamId, userId, userName, rating, sessionId, emoji, emojiType } = data;

    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Rate limit emoji/star reactions (30 per minute per client)
    if (action === 'emoji' || action === 'star') {
      const rateCheck = checkRateLimit(`react-emoji:${clientId}`, {
        maxRequests: 30,
        windowMs: 60 * 1000,
        blockDurationMs: 60 * 1000
      });
      if (!rateCheck.allowed) {
        return rateLimitResponse(rateCheck.retryAfter!);
      }
    }

    // Rate limit join/heartbeat (10 per minute - prevents rapid reconnects)
    if (action === 'join' || action === 'heartbeat') {
      const rateCheck = checkRateLimit(`react-presence:${clientId}:${streamId}`, {
        maxRequests: 10,
        windowMs: 60 * 1000
      });
      if (!rateCheck.allowed) {
        return rateLimitResponse(rateCheck.retryAfter!);
      }
    }

    const now = new Date().toISOString();

    switch (action) {
      case 'emoji': {
        // Broadcast emoji reaction to all viewers via Pusher and increment counter
        const { sessionId } = data;
        const channel = `stream-${streamId}`;
        const reactionData = {
          type: emojiType || 'emoji',
          emoji: emoji || '❤️',
          userName: userName || 'Someone',
          userId: userId || null,
          sessionId: sessionId || null,
          timestamp: now
        };

        console.log('[react.ts] Broadcasting emoji to channel:', channel, 'data:', reactionData);
        const pusherSuccess = await triggerPusher(channel, 'reaction', reactionData, env);
        console.log('[react.ts] Pusher broadcast result:', pusherSuccess);

        // Increment total likes counter
        let totalLikes = 0;
        try {
          const result = await incrementField('livestreamSlots', streamId, 'totalLikes', 1);
          totalLikes = result.newValue;
        } catch (e) {
          try {
            const result = await incrementField('livestreams', streamId, 'totalLikes', 1);
            totalLikes = result.newValue;
          } catch (e2) {
            // Stream doesn't exist in either collection (playlist mode) - that's OK
            console.log('[react] Stream not found for reaction counter, skipping increment');
          }
        }

        if (!pusherSuccess) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to broadcast reaction via Pusher'
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Reaction broadcast',
          channel,
          pusherSuccess,
          totalLikes
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'star': {
        // Broadcast star rating animation to all viewers
        const starCount = rating || 1;

        await triggerPusher(`stream-${streamId}`, 'reaction', {
          type: 'star',
          count: starCount,
          userName: userName || 'Someone',
          userId: userId || null,
          timestamp: now
        }, env);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Star reaction broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'like': {
        if (!userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Must be logged in to like'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        // Always add a like (no toggle - reactions accumulate)
        await addDocument('livestream-reactions', {
          streamId,
          userId,
          type: 'like',
          createdAt: now
        });

        // Increment total likes - try livestreamSlots first, fall back to livestreams
        // If neither exists (playlist mode), just skip the counter update
        let totalLikes = 0;
        try {
          const result = await incrementField('livestreamSlots', streamId, 'totalLikes', 1);
          totalLikes = result.newValue;
        } catch (e) {
          try {
            // Fall back to livestreams collection
            const result = await incrementField('livestreams', streamId, 'totalLikes', 1);
            totalLikes = result.newValue;
          } catch (e2) {
            // Stream doesn't exist in either collection (playlist mode) - that's OK
            console.log('[react] Stream not found for like counter, skipping increment');
          }
        }

        // Broadcast updated like count to all viewers (only if we have a count)
        if (totalLikes > 0) {
          await triggerPusher(`stream-${streamId}`, 'like-update', {
            totalLikes,
            timestamp: now
          }, env);
        }

        return new Response(JSON.stringify({
          success: true,
          liked: true,
          totalLikes,
          message: 'Stream liked!'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'rate': {
        if (!userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Must be logged in to rate'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        
        if (!rating || rating < 1 || rating > 5) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Rating must be between 1 and 5'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Check for existing rating
        const existingRatings = await queryCollection('livestream-reactions', {
          filters: [
            { field: 'streamId', op: 'EQUAL', value: streamId },
            { field: 'userId', op: 'EQUAL', value: userId },
            { field: 'type', op: 'EQUAL', value: 'rating' }
          ],
          limit: 1
        });

        const { doc: streamData, collection: rateCollection } = await getStreamDocument(streamId);
        if (!streamData) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Stream not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        let newAverage: number;
        let newCount: number;

        if (existingRatings.length > 0) {
          // Update existing rating
          const existingRating = existingRatings[0];
          const oldRating = existingRating.rating;
          await updateDocument('livestream-reactions', existingRating.id, { rating, updatedAt: now });

          // Recalculate average
          const totalRating = (streamData.averageRating * streamData.ratingCount) - oldRating + rating;
          newCount = streamData.ratingCount;
          newAverage = totalRating / newCount;
        } else {
          // Add new rating
          await addDocument('livestream-reactions', {
            streamId,
            userId,
            type: 'rating',
            rating,
            createdAt: now
          });

          // Calculate new average
          const totalRating = (streamData.averageRating * streamData.ratingCount) + rating;
          newCount = streamData.ratingCount + 1;
          newAverage = totalRating / newCount;
        }

        await updateDocument(rateCollection, streamId, {
          averageRating: newAverage,
          ratingCount: newCount
        });
        
        return new Response(JSON.stringify({
          success: true,
          rating,
          averageRating: newAverage,
          ratingCount: newCount
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'join': {
        // Track viewer joining
        const viewerSession = {
          streamId,
          userId: userId || null,
          sessionId: sessionId || `anon_${Date.now()}`,
          joinedAt: now,
          leftAt: null,
          isActive: true
        };

        await addDocument('livestream-viewers', viewerSession);

        // Update viewer counts - use correct collection
        const { doc: streamDoc, collection } = await getStreamDocument(streamId);
        const currentViewers = (streamDoc?.currentViewers || 0) + 1;
        const peakViewers = Math.max(streamDoc?.peakViewers || 0, currentViewers);

        await updateDocument(collection, streamId, {
          currentViewers,
          peakViewers
        });

        // Increment total views
        await incrementField(collection, streamId, 'totalViews', 1);

        // Broadcast viewer count update to all viewers
        await triggerPusher(`stream-${streamId}`, 'viewer-update', {
          currentViewers,
          peakViewers,
          timestamp: now
        }, env);

        return new Response(JSON.stringify({
          success: true,
          sessionId: viewerSession.sessionId,
          currentViewers,
          peakViewers
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'leave': {
        // Track viewer leaving
        if (sessionId) {
          const sessions = await queryCollection('livestream-viewers', {
            filters: [
              { field: 'streamId', op: 'EQUAL', value: streamId },
              { field: 'sessionId', op: 'EQUAL', value: sessionId },
              { field: 'isActive', op: 'EQUAL', value: true }
            ],
            limit: 1
          });

          if (sessions.length > 0) {
            await updateDocument('livestream-viewers', sessions[0].id, {
              isActive: false,
              leftAt: now
            });

            // Decrement viewer count in correct collection
            const { doc: leaveDoc, collection: leaveCollection } = await getStreamDocument(streamId);
            await incrementField(leaveCollection, streamId, 'currentViewers', -1);

            // Broadcast updated viewer count
            const newViewerCount = Math.max(0, (leaveDoc?.currentViewers || 1) - 1);
            await triggerPusher(`stream-${streamId}`, 'viewer-update', {
              currentViewers: newViewerCount,
              timestamp: now
            }, env);
          }
        }

        return new Response(JSON.stringify({
          success: true
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'heartbeat': {
        // Keep viewer session alive
        if (sessionId) {
          const sessions = await queryCollection('livestream-viewers', {
            filters: [
              { field: 'streamId', op: 'EQUAL', value: streamId },
              { field: 'sessionId', op: 'EQUAL', value: sessionId },
              { field: 'isActive', op: 'EQUAL', value: true }
            ],
            limit: 1
          });

          if (sessions.length > 0) {
            await updateDocument('livestream-viewers', sessions[0].id, {
              lastHeartbeat: now
            });
          }
        }

        // Return current stats from correct collection
        const { doc: streamData } = await getStreamDocument(streamId);
        
        return new Response(JSON.stringify({
          success: true,
          currentViewers: streamData?.currentViewers || 0,
          totalLikes: streamData?.totalLikes || 0
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'shoutout': {
        // Broadcast shoutout to all viewers via Pusher
        const { message } = data;

        if (!userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Must be logged in to shoutout'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        if (!message || message.length > 30) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Shoutout must be 1-30 characters'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const shoutoutChannel = `stream-${streamId}`;
        console.log('[react.ts] Broadcasting shoutout to channel:', shoutoutChannel);
        const shoutoutSuccess = await triggerPusher(shoutoutChannel, 'shoutout', {
          name: userName || 'Someone',
          message: message,
          timestamp: now
        }, env);
        console.log('[react.ts] Shoutout broadcast result:', shoutoutSuccess);

        if (!shoutoutSuccess) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to broadcast shoutout via Pusher'
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Shoutout broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid action'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
  } catch (error) {
    console.error('[livestream/react] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process reaction'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Get user's reactions for a stream
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const userId = url.searchParams.get('userId');
    
    if (!streamId || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID and User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const reactions = await queryCollection('livestream-reactions', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId },
        { field: 'userId', op: 'EQUAL', value: userId }
      ]
    });

    let hasLiked = false;
    let userRating = null;

    reactions.forEach(data => {
      if (data.type === 'like') hasLiked = true;
      if (data.type === 'rating') userRating = data.rating;
    });
    
    return new Response(JSON.stringify({
      success: true,
      hasLiked,
      userRating
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    console.error('[livestream/react] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get reactions'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
