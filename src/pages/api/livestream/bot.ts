// src/pages/api/livestream/bot.ts
// Bot API - Send announcements and scheduled messages
// POST /api/livestream/bot - Send a bot message to a stream

import type { APIRoute } from 'astro';
import { addDocument, getDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { BOT_USER, BOT_ANNOUNCEMENTS } from '../../../lib/chatbot';

// Helper to initialize Firebase and return env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  return env;
}

// Simple MD5 for Pusher (handles unicode)
function simpleMd5(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
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

// HMAC-SHA256 helper
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBuffer = encoder.encode(data);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Trigger Pusher event
async function triggerPusher(channel: string, event: string, data: any, env?: any): Promise<boolean> {
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) return false;

  try {
    const body = JSON.stringify({ name: event, channel, data: JSON.stringify(data) });
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

    return response.ok;
  } catch {
    return false;
  }
}

// Hardcoded admin UIDs (same as other admin endpoints)
const ADMIN_UIDS = [
  '8WmxYeCp4PSym5iWHahgizokn5F2',
  'davidhagon'
];

// Send bot message to a stream
async function sendBotMessage(streamId: string, message: string, env: any): Promise<{ success: boolean; messageId?: string }> {
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
  const env = initFirebase(locals);

  try {
    const data = await request.json();
    const { streamId, message, announcement, adminId } = data;

    // Verify admin (optional - can be called internally too)
    // For scheduled tasks, adminId might be 'system'
    if (adminId && adminId !== 'system' && !ADMIN_UIDS.includes(adminId)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
          return new Response(JSON.stringify({
            success: false,
            error: 'Unknown announcement type'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (!messageText) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message or announcement type is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const result = await sendBotMessage(streamId, messageText, env);

    return new Response(JSON.stringify({
      success: result.success,
      messageId: result.messageId
    }), {
      status: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[bot] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send bot message',
      details: error?.message || String(error)
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// GET: Check for streams that need announcements (for scheduled jobs)
export const GET: APIRoute = async ({ request, locals }) => {
  const env = initFirebase(locals);

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

      return new Response(JSON.stringify({
        success: true,
        upcoming: upcomingSlots.map(slot => ({
          id: slot.id,
          djName: slot.djName,
          scheduledFor: slot.scheduledFor,
          title: slot.title
        }))
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Default: return bot info
    return new Response(JSON.stringify({
      success: true,
      bot: BOT_USER,
      commands: ['!help', '!dj', '!schedule', '!next', '!rules'],
      announcements: Object.keys(BOT_ANNOUNCEMENTS)
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[bot] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get bot info'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
