// src/pages/api/pusher/auth.ts
// Pusher authentication endpoint for presence channels
// Replaces Firebase heartbeat polling with Pusher's built-in presence tracking

import type { APIRoute } from 'astro';
import { verifyRequestUser, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

const ALLOWED_ORIGINS = [
  'https://freshwax.co.uk',
  'https://www.freshwax.co.uk',
  'https://freshwax.pages.dev',
  'http://localhost:4321',
  'http://localhost:3000',
  'http://127.0.0.1:4321',
];

function getAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (origin.endsWith('.freshwax.pages.dev')) return origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

// Handle CORS preflight
export const OPTIONS: APIRoute = async ({ request }) => {
  const origin = getAllowedOrigin(request);
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-id, x-user-name, x-user-avatar',
      ...(origin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    }
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;

    // Initialize Firebase for auth verification
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Get Pusher credentials
    const appId = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const key = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
    const secret = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;

    if (!appId || !key || !secret) {
      console.error('[Pusher Auth] Missing credentials');
      return new Response(JSON.stringify({ error: 'Pusher not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parse the request body (Pusher sends form data)
    const formData = await request.formData();
    const socketId = formData.get('socket_id') as string;
    const channelName = formData.get('channel_name') as string;

    if (!socketId || !channelName) {
      return new Response(JSON.stringify({ error: 'Missing socket_id or channel_name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Only allow presence channels
    if (!channelName.startsWith('presence-')) {
      return new Response(JSON.stringify({ error: 'Only presence channels supported' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SECURITY: Use verified Firebase token for user identity when available
    // Falls back to anon for unauthenticated viewers (livestream is public)
    const oderId = socketId.split('.').join('_');
    let userId: string;
    let userName = request.headers.get('x-user-name') || 'Viewer';
    const userAvatar = request.headers.get('x-user-avatar') || '';

    const { userId: verifiedUserId } = await verifyRequestUser(request).catch(() => ({ userId: null }));
    if (verifiedUserId) {
      userId = verifiedUserId;
    } else {
      userId = 'anon_' + oderId;
      // Keep userName from x-user-name header (don't override to 'Viewer')
    }

    // Build presence data
    const presenceData = {
      user_id: userId,
      user_info: {
        name: userName,
        avatar: userAvatar
      }
    };

    // Generate Pusher signature using HMAC-SHA256
    const stringToSign = socketId + ':' + channelName + ':' + JSON.stringify(presenceData);

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(stringToSign);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const signatureHex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Log successful auth
    console.log('[Pusher Auth] Success for user:', userId, 'channel:', channelName);

    // Return auth response in Pusher's expected format
    return new Response(JSON.stringify({
      auth: key + ':' + signatureHex,
      channel_data: JSON.stringify(presenceData)
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...(getAllowedOrigin(request) ? {
          'Access-Control-Allow-Origin': getAllowedOrigin(request)!,
          'Access-Control-Allow-Credentials': 'true',
        } : {}),
      }
    });

  } catch (error: any) {
    console.error('[Pusher Auth] Error:', error);
    return new Response(JSON.stringify({ error: 'Auth failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
