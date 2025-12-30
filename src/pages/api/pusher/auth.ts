// src/pages/api/pusher/auth.ts
// Pusher authentication endpoint for presence channels
// Replaces Firebase heartbeat polling with Pusher's built-in presence tracking

import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any).runtime?.env;

    // Get Pusher credentials
    const appId = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const key = env?.PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const secret = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;

    if (!appId || !key || !secret) {
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

    // Get user info from request headers (set by client)
    const oderId = socketId.split('.').join('_');
    const userId = request.headers.get('x-user-id') || ('anon_' + oderId);
    const userName = request.headers.get('x-user-name') || 'Viewer';
    const userAvatar = request.headers.get('x-user-avatar') || '';

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

    // Return auth response in Pusher's expected format
    return new Response(JSON.stringify({
      auth: key + ':' + signatureHex,
      channel_data: JSON.stringify(presenceData)
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Pusher Auth] Error:', error);
    return new Response(JSON.stringify({ error: 'Auth failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
