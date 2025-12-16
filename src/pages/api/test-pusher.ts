// src/pages/api/test-pusher.ts
// Test endpoint to verify Pusher configuration is working
// GET /api/test-pusher - Check config
// POST /api/test-pusher - Send test event

import type { APIRoute } from 'astro';

// Simple MD5 for Pusher body hash
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

// Get Pusher config from environment
function getPusherConfig(env?: any) {
  return {
    appId: env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID || null,
    key: env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY || null,
    secret: env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET || null,
    cluster: env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu',
  };
}

// GET: Check Pusher configuration status
export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any)?.runtime?.env;
  const config = getPusherConfig(env);

  const status = {
    timestamp: new Date().toISOString(),
    environment: env ? 'cloudflare' : 'local',
    config: {
      PUSHER_APP_ID: config.appId ? `SET (${config.appId.length} chars)` : 'MISSING',
      PUBLIC_PUSHER_KEY: config.key ? `SET (${config.key.substring(0, 8)}...)` : 'MISSING',
      PUSHER_SECRET: config.secret ? `SET (${config.secret.length} chars)` : 'MISSING',
      PUBLIC_PUSHER_CLUSTER: config.cluster || 'MISSING',
    },
    ready: !!(config.appId && config.key && config.secret && config.cluster),
    issues: [] as string[],
  };

  if (!config.appId) status.issues.push('PUSHER_APP_ID is not set');
  if (!config.key) status.issues.push('PUBLIC_PUSHER_KEY is not set');
  if (!config.secret) status.issues.push('PUSHER_SECRET is not set');
  if (!config.cluster) status.issues.push('PUBLIC_PUSHER_CLUSTER is not set');

  if (status.ready) {
    status.issues.push('All Pusher credentials are configured. Use POST to send a test event.');
  }

  return new Response(JSON.stringify(status, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

// POST: Send a test Pusher event
export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  const config = getPusherConfig(env);

  // Check config
  if (!config.appId || !config.key || !config.secret) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Pusher credentials not configured',
      missing: {
        appId: !config.appId,
        key: !config.key,
        secret: !config.secret,
      }
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Parse request body for optional channel/event override
    let channel = 'test-channel';
    let event = 'test-event';
    let customData = null;

    try {
      const body = await request.json();
      if (body.channel) channel = body.channel;
      if (body.event) event = body.event;
      if (body.data) customData = body.data;
    } catch {
      // No body or invalid JSON - use defaults
    }

    const testData = customData || {
      message: 'Pusher test from Fresh Wax',
      timestamp: new Date().toISOString(),
      source: 'test-pusher endpoint',
    };

    // Build Pusher request
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(testData)
    });

    const bodyMd5 = simpleMd5(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const params = new URLSearchParams({
      auth_key: config.key,
      auth_timestamp: timestamp,
      auth_version: '1.0',
      body_md5: bodyMd5
    });
    params.sort();

    const stringToSign = `POST\n/apps/${config.appId}/events\n${params.toString()}`;
    const signature = await hmacSha256Hex(config.secret, stringToSign);

    const url = `https://api-${config.cluster}.pusher.com/apps/${config.appId}/events?${params.toString()}&auth_signature=${signature}`;

    // Send to Pusher
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    const responseText = await response.text();

    if (!response.ok) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Pusher API rejected the request',
        status: response.status,
        statusText: response.statusText,
        response: responseText,
        debug: {
          channel,
          event,
          cluster: config.cluster,
          appIdUsed: config.appId.substring(0, 4) + '...',
        }
      }, null, 2), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Test event sent successfully!',
      details: {
        channel,
        event,
        data: testData,
        pusherResponse: responseText || '{}',
      },
      nextSteps: [
        'Open your browser console on the live page',
        `Subscribe to channel "${channel}" to verify receipt`,
        'Or check Pusher Dashboard > Debug Console',
      ]
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send test event',
      details: error.message || String(error),
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
