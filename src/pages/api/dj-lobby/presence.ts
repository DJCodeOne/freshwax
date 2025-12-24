// src/pages/api/dj-lobby/presence.ts
// DJ Lobby presence tracking - Pusher-based (no Firebase onSnapshot)
// Replaces client-side Firebase listener with server-mediated Pusher events

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

// Pusher configuration is loaded from env at runtime (not module level)
// This is required for Cloudflare Workers compatibility

// Web Crypto API helper for MD5 hash (hex output)
async function md5Hex(data: string): Promise<string> {
  // Note: Web Crypto doesn't support MD5, so we use a simple implementation
  // This is only for Pusher body_md5 which is not security-critical
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  // Use SubtleCrypto for SHA-256 as fallback (Pusher accepts this too)
  // Actually Pusher requires MD5, so let's implement a simple version
  let hash = 0x12345678;
  for (let i = 0; i < dataBuffer.length; i++) {
    hash = ((hash << 5) - hash + dataBuffer[i]) | 0;
  }
  // For Pusher, we need actual MD5 - let's use a proper implementation
  return simpleMd5(data);
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

// Trigger Pusher event
async function triggerPusher(channel: string, event: string, data: any, env?: any): Promise<boolean> {
  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
    console.error('[Pusher] Missing configuration');
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

// In-memory cache for online DJs (reduces Firebase reads)
const onlineDjsCache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 30 * 1000; // 30 seconds

function getCachedOnlineDjs(): any[] | null {
  const cached = onlineDjsCache.get('online-djs');
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }
  return null;
}

function setCachedOnlineDjs(djs: any[]): void {
  onlineDjsCache.set('online-djs', {
    data: djs,
    expires: Date.now() + CACHE_TTL
  });
}

// GET: Get online DJs list (initial load and polling fallback)
export const GET: APIRoute = async ({ request, locals }) => {
  console.log('[DEBUG] presence.ts GET called');

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  const firebaseApiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
  const firebaseProjectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;

  console.log('[DEBUG] Firebase config:', {
    hasApiKey: !!firebaseApiKey,
    apiKeyLength: firebaseApiKey?.length || 0,
    hasProjectId: !!firebaseProjectId,
    projectId: firebaseProjectId
  });

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: firebaseProjectId,
    FIREBASE_API_KEY: firebaseApiKey,
  });

  try {
    // Check cache first
    const cached = getCachedOnlineDjs();
    if (cached) {
      return new Response(JSON.stringify({
        success: true,
        djs: cached,
        source: 'cache'
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=10'
        }
      });
    }

    // Query all presence documents and filter client-side
    // (timestamp filters in REST API can be unreliable)
    const allDjs = await queryCollection('djLobbyPresence', {
      cacheTime: 15000, // 15 second cache - presence doesn't need to be instant
      limit: 100
    });

    // Filter to DJs active in last 2 minutes
    const twoMinutesAgo = Date.now() - 120000;
    const activeDjs = allDjs.filter(dj => {
      if (!dj.lastSeen) return false;
      try {
        const lastSeenTime = dj.lastSeen instanceof Date
          ? dj.lastSeen.getTime()
          : new Date(dj.lastSeen).getTime();
        return !isNaN(lastSeenTime) && lastSeenTime > twoMinutesAgo;
      } catch {
        return false;
      }
    });

    // Add odamiMa field for compatibility
    const djsWithOdamiMa = activeDjs.map(dj => ({ ...dj, odamiMa: dj.id }));

    // Cache the result
    setCachedOnlineDjs(djsWithOdamiMa);

    return new Response(JSON.stringify({
      success: true,
      djs: djsWithOdamiMa,
      source: 'firestore',
      debug: { total: allDjs.length, active: activeDjs.length }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10'
      }
    });

  } catch (error: any) {
    console.error('[dj-lobby/presence] GET Error:', error?.message || error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get online DJs',
      details: error?.message || 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Join/Leave/Heartbeat
export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Get idToken from Authorization header
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    const data = await request.json();
    const { action, userId, name, avatar, avatarLetter, isReady } = data;

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const now = new Date();

    switch (action) {
      case 'join': {
        // Update presence document
        await setDocument('djLobbyPresence', userId, {
          odamiMa: userId,
          name: name || 'DJ',
          avatar: avatar || null,
          avatarLetter: avatarLetter || (name ? name.charAt(0).toUpperCase() : 'D'),
          isReady: isReady || false,
          lastSeen: now,
          joinedAt: now
        }, idToken);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast to all lobby members via Pusher
        await triggerPusher('dj-lobby', 'dj-joined', {
          id: userId,
          odamiMa: userId,
          name: name || 'DJ',
          avatar: avatar || null,
          avatarLetter: avatarLetter || (name ? name.charAt(0).toUpperCase() : 'D'),
          isReady: isReady || false,
          timestamp: now.toISOString()
        }, env);

        return new Response(JSON.stringify({
          success: true,
          message: 'Joined lobby'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'leave': {
        // Delete presence document
        await deleteDocument('djLobbyPresence', userId, idToken);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast leave event
        await triggerPusher('dj-lobby', 'dj-left', {
          id: userId,
          timestamp: now.toISOString()
        }, env);

        return new Response(JSON.stringify({
          success: true,
          message: 'Left lobby'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'heartbeat': {
        // Update last seen timestamp
        await updateDocument('djLobbyPresence', userId, {
          lastSeen: now,
          isReady: isReady ?? false
        }, idToken);

        // Broadcast status update if ready state changed
        if (typeof isReady === 'boolean') {
          await triggerPusher('dj-lobby', 'dj-status', {
            id: userId,
            isReady,
            timestamp: now.toISOString()
          }, env);
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Heartbeat recorded'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'update': {
        // Update DJ info (name, avatar, ready state)
        const updateData: any = { lastSeen: now };
        if (name) updateData.name = name;
        if (avatar !== undefined) updateData.avatar = avatar;
        if (avatarLetter) updateData.avatarLetter = avatarLetter;
        if (typeof isReady === 'boolean') updateData.isReady = isReady;

        await updateDocument('djLobbyPresence', userId, updateData, idToken);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast update
        await triggerPusher('dj-lobby', 'dj-updated', {
          id: userId,
          ...updateData,
          timestamp: now.toISOString()
        }, env);

        return new Response(JSON.stringify({
          success: true,
          message: 'Updated'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid action'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

  } catch (error) {
    console.error('[dj-lobby/presence] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update presence'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Cleanup stale presence entries (cron job endpoint)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const twoMinutesAgo = new Date(Date.now() - 120000);

    const staleDjs = await queryCollection('djLobbyPresence', {
      filters: [{ field: 'lastSeen', op: 'LESS_THAN', value: twoMinutesAgo }]
      // No cache needed for cleanup - runs infrequently
    });

    const staleIds: string[] = staleDjs.map(dj => dj.id);

    if (staleIds.length > 0) {
      // Delete each stale presence document
      await Promise.all(staleIds.map(id => deleteDocument('djLobbyPresence', id)));

      // Invalidate cache
      onlineDjsCache.delete('online-djs');

      // Broadcast cleanup
      for (const id of staleIds) {
        await triggerPusher('dj-lobby', 'dj-left', {
          id,
          reason: 'timeout',
          timestamp: new Date().toISOString()
        }, env);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      cleaned: staleIds.length
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[dj-lobby/presence] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Cleanup failed'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
