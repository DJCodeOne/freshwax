// src/pages/api/livestream/listeners.ts
// API endpoint for tracking and retrieving active listeners on a live stream
// Uses Cloudflare KV for fast, edge-cached listener tracking (no Firebase)

import type { APIRoute } from 'astro';
import { initKVCache, kvGet, kvSet, kvDelete, kvList } from '../../../lib/kv-cache';

export const prerender = false;

const LISTENER_TTL = 120; // 2 minutes - listeners expire if no heartbeat

// Helper to initialize KV
function initKV(locals: any) {
  const env = locals?.runtime?.env;
  initKVCache(env);
  return env;
}

// Pusher helper for real-time updates
async function triggerPusher(channel: string, event: string, data: any, env: any) {
  try {
    const appId = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const key = env?.PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const secret = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const cluster = env?.PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!appId || !key || !secret) return false;

    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data: JSON.stringify(data) });
    const bodyMd5 = await crypto.subtle.digest('MD5', new TextEncoder().encode(body))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));

    const stringToSign = `POST\n/apps/${appId}/events\nauth_key=${key}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(k => crypto.subtle.sign('HMAC', k, new TextEncoder().encode(stringToSign)))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));

    const url = `https://api-${cluster}.pusher.com/apps/${appId}/events?auth_key=${key}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return resp.ok;
  } catch (e) {
    console.error('[Pusher] Error:', e);
    return false;
  }
}

// Get listener count from KV
async function getListenerCount(streamId: string): Promise<{ count: number; listeners: any[] }> {
  try {
    // Get the listener list for this stream
    const listKey = `listeners:${streamId}`;
    const listenerMap = await kvGet<Record<string, { name: string; avatar?: string; lastSeen: number }>>(listKey, { prefix: 'stream' });

    if (!listenerMap) {
      return { count: 0, listeners: [] };
    }

    // Filter out expired listeners (older than 2 minutes)
    const now = Date.now();
    const twoMinutesAgo = now - (2 * 60 * 1000);
    const activeListeners: any[] = [];

    for (const [userId, data] of Object.entries(listenerMap)) {
      if (data.lastSeen > twoMinutesAgo) {
        activeListeners.push({
          id: userId,
          name: data.name || 'Viewer',
          avatarUrl: data.avatar || null
        });
      }
    }

    return { count: activeListeners.length, listeners: activeListeners };
  } catch (e) {
    console.error('[listeners] Error getting count:', e);
    return { count: 0, listeners: [] };
  }
}

// Add or update a listener in KV
async function upsertListener(
  streamId: string,
  userId: string,
  userName?: string,
  avatarUrl?: string
): Promise<number> {
  try {
    const listKey = `listeners:${streamId}`;

    // Get current listeners
    let listenerMap = await kvGet<Record<string, { name: string; avatar?: string; lastSeen: number }>>(listKey, { prefix: 'stream' }) || {};

    // Clean up expired listeners while we're here
    const now = Date.now();
    const twoMinutesAgo = now - (2 * 60 * 1000);
    for (const [id, data] of Object.entries(listenerMap)) {
      if (data.lastSeen < twoMinutesAgo) {
        delete listenerMap[id];
      }
    }

    // Add/update this listener
    listenerMap[userId] = {
      name: userName || 'Viewer',
      avatar: avatarUrl,
      lastSeen: now
    };

    // Save back to KV with TTL
    await kvSet(listKey, listenerMap, { prefix: 'stream', ttl: LISTENER_TTL });

    // Count active listeners
    return Object.keys(listenerMap).length;
  } catch (e) {
    console.error('[listeners] Error upserting:', e);
    return 0;
  }
}

// Remove a listener from KV
async function removeListener(streamId: string, userId: string): Promise<number> {
  try {
    const listKey = `listeners:${streamId}`;

    // Get current listeners
    let listenerMap = await kvGet<Record<string, { name: string; avatar?: string; lastSeen: number }>>(listKey, { prefix: 'stream' }) || {};

    // Remove this listener
    delete listenerMap[userId];

    // Clean up expired while we're here
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
    for (const [id, data] of Object.entries(listenerMap)) {
      if (data.lastSeen < twoMinutesAgo) {
        delete listenerMap[id];
      }
    }

    // Save back to KV
    if (Object.keys(listenerMap).length > 0) {
      await kvSet(listKey, listenerMap, { prefix: 'stream', ttl: LISTENER_TTL });
    } else {
      await kvDelete(listKey, { prefix: 'stream' });
    }

    return Object.keys(listenerMap).length;
  } catch (e) {
    console.error('[listeners] Error removing:', e);
    return 0;
  }
}

// GET - Retrieve list of active listeners for a stream
export const GET: APIRoute = async ({ request, locals }) => {
  initKV(locals);

  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');

    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const { count, listeners } = await getListenerCount(streamId);

    return new Response(JSON.stringify({
      success: true,
      listeners,
      count
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error fetching listeners:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch listeners',
      listeners: [],
      count: 0
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST - Join, leave, or heartbeat as a listener
export const POST: APIRoute = async ({ request, locals }) => {
  const env = initKV(locals);

  try {
    let body;

    // Handle both JSON and sendBeacon (text/plain) requests
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      const text = await request.text();
      body = JSON.parse(text);
    }

    const { action, streamId, userId, userName, avatarUrl } = body;

    if (!streamId || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID and User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    let activeCount: number;

    if (action === 'leave') {
      // Remove listener
      activeCount = await removeListener(streamId, userId);

      // Broadcast update via Pusher
      const channel = `stream-${streamId}`;
      await triggerPusher(channel, 'viewer-update', {
        count: activeCount,
        streamId,
        timestamp: Date.now()
      }, env);

      return new Response(JSON.stringify({
        success: true,
        message: 'Left stream',
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else {
      // Join or heartbeat - both upsert the listener
      activeCount = await upsertListener(streamId, userId, userName, avatarUrl);

      // Broadcast update via Pusher
      const channel = `stream-${streamId}`;
      await triggerPusher(channel, 'viewer-update', {
        count: activeCount,
        streamId,
        timestamp: Date.now()
      }, env);

      return new Response(JSON.stringify({
        success: true,
        message: action === 'join' ? 'Joined as listener' : 'Heartbeat received',
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error) {
    console.error('Error updating listener:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update listener status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
