// src/pages/api/dj-lobby/pusher-auth.ts
// Pusher authentication for private DJ channels
// Required for private-dj-{userId} channels

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, initFirebaseEnv } from '../../../lib/firebase-rest';

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

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: auth attempts - 10 per 15 minutes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`pusher-auth:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const env = (locals as any)?.runtime?.env;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;

  // Initialize Firebase for token verification
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // Verify the user is authenticated via Firebase token
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return new Response(JSON.stringify({
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const formData = await request.formData();
    const socketId = formData.get('socket_id') as string;
    const channelName = formData.get('channel_name') as string;

    if (!socketId || !channelName) {
      return new Response(JSON.stringify({
        error: 'Missing socket_id or channel_name'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!PUSHER_KEY || !PUSHER_SECRET) {
      console.error('[pusher-auth] Missing Pusher configuration');
      return new Response(JSON.stringify({
        error: 'Server configuration error'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate that the authenticated user is authorized for this private channel
    // Channel format: private-dj-{userId}
    if (channelName.startsWith('private-dj-')) {
      const channelUserId = channelName.replace('private-dj-', '');

      // Verified user must match the channel they're subscribing to
      if (channelUserId !== verifiedUserId) {
        return new Response(JSON.stringify({
          error: 'Forbidden - cannot subscribe to another user\'s private channel'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Generate Pusher signature using Web Crypto API
    const stringToSign = `${socketId}:${channelName}`;
    const signature = await hmacSha256Hex(PUSHER_SECRET, stringToSign);

    const auth = `${PUSHER_KEY}:${signature}`;

    return new Response(JSON.stringify({ auth }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[pusher-auth] Error:', error);
    return new Response(JSON.stringify({
      error: 'Authentication failed'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
