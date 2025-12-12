// src/pages/api/dj-lobby/pusher-auth.ts
// Pusher authentication for private DJ channels
// Required for private-dj-{userId} channels

import type { APIRoute } from 'astro';
import { createHmac } from 'crypto';

// Pusher configuration (from .env)
const PUSHER_KEY = import.meta.env.PUBLIC_PUSHER_KEY;
const PUSHER_SECRET = import.meta.env.PUSHER_SECRET;

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    const socketId = formData.get('socket_id') as string;
    const channelName = formData.get('channel_name') as string;
    const userId = formData.get('user_id') as string; // Sent by client
    
    if (!socketId || !channelName) {
      return new Response(JSON.stringify({
        error: 'Missing socket_id or channel_name'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Validate that the user is authorized for this private channel
    // Channel format: private-dj-{userId}
    if (channelName.startsWith('private-dj-')) {
      const channelUserId = channelName.replace('private-dj-', '');
      
      // User can only auth for their own private channel
      if (userId && channelUserId !== userId) {
        return new Response(JSON.stringify({
          error: 'Forbidden - cannot subscribe to another user\'s private channel'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    // Generate Pusher signature
    const stringToSign = `${socketId}:${channelName}`;
    const signature = createHmac('sha256', PUSHER_SECRET)
      .update(stringToSign)
      .digest('hex');
    
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
