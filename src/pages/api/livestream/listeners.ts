// src/pages/api/livestream/listeners.ts
// API endpoint for tracking and retrieving active listeners on a live stream

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet } from '../../../lib/kv-cache';

export const prerender = false;

// In-memory cache for viewer counts (reduces KV reads too)
const viewerCountCache = new Map<string, { count: number; timestamp: number }>();
const VIEWER_CACHE_TTL = 30000; // 30 seconds

// Helper to initialize Firebase and KV
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initKVCache(env);
  return env;
}

// Get cached viewer count (memory -> KV -> fresh query)
async function getCachedViewerCount(streamId: string): Promise<number | null> {
  // Check memory cache first
  const memCached = viewerCountCache.get(streamId);
  if (memCached && Date.now() - memCached.timestamp < VIEWER_CACHE_TTL) {
    return memCached.count;
  }

  // Check KV cache
  const kvCached = await kvGet<{ count: number }>(`viewers:${streamId}`, { prefix: 'listeners' });
  if (kvCached) {
    viewerCountCache.set(streamId, { count: kvCached.count, timestamp: Date.now() });
    return kvCached.count;
  }

  return null;
}

// Update viewer count in cache
async function setCachedViewerCount(streamId: string, count: number): Promise<void> {
  viewerCountCache.set(streamId, { count, timestamp: Date.now() });
  await kvSet(`viewers:${streamId}`, { count }, { prefix: 'listeners', ttl: 30 });
}

// Pusher helper
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

// Count active viewers and broadcast via Pusher (called on join/leave only)
async function countAndBroadcastViewers(streamId: string, env: any): Promise<number> {
  try {
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);

    // Query listeners for this stream
    const results = await queryCollection('stream-listeners', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId }
      ],
      limit: 200,
      cacheTime: 15000 // 15 second cache on the query itself
    });

    // Count only recent/active listeners
    const activeCount = results.filter(data => (data.lastSeen || 0) > twoMinutesAgo).length;

    // Update the viewer count cache (used by heartbeats to avoid Firebase queries)
    await setCachedViewerCount(streamId, activeCount);

    // Broadcast to Pusher on the stream's reaction channel
    const channel = `stream-${streamId}`;
    await triggerPusher(channel, 'viewer-update', {
      count: activeCount,
      streamId,
      timestamp: Date.now()
    }, env);

    // Also update currentViewers on the stream slot
    try {
      await updateDocument('livestreamSlots', streamId, {
        currentViewers: activeCount
      });
    } catch (e) {
      console.log('[listeners] Could not update currentViewers:', e);
    }

    return activeCount;
  } catch (e) {
    console.error('[listeners] Error counting viewers:', e);
    return 0;
  }
}

// GET - Retrieve list of active listeners for a stream
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    
    if (!streamId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Stream ID required' 
      }), { status: 400 });
    }
    
    // Get active listeners from Firestore
    // Listeners are stored with a TTL - only show those active in last 2 minutes
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);

    // Query by streamId only, then filter by lastSeen in code
    // This avoids needing a composite index
    const results = await queryCollection('stream-listeners', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId }
      ],
      limit: 100
    });

    // Filter to only recent listeners and map to response format
    const listeners = results
      .filter(data => (data.lastSeen || 0) > twoMinutesAgo)
      .map(data => ({
        id: data.id,
        name: data.userName || 'Anonymous',
        avatarUrl: data.avatarUrl || null,
        joinedAt: data.joinedAt || data.lastSeen
      }))
      .slice(0, 50);
    
    return new Response(JSON.stringify({ 
      success: true, 
      listeners,
      count: listeners.length
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error fetching listeners:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to fetch listeners',
      listeners: []
    }), { status: 500 });
  }
};

// POST - Join or leave a stream as a listener
export const POST: APIRoute = async ({ request, locals }) => {
  const env = initFirebase(locals);
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
      }), { status: 400 });
    }
    
    const listenerId = `${streamId}_${userId}`;

    if (action === 'join') {
      // Add or update listener
      await setDocument('stream-listeners', listenerId, {
        streamId,
        userId,
        userName: userName || 'Anonymous',
        avatarUrl: avatarUrl || null,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      });

      // Increment totalViews on the stream slot (counts every visit, even repeat visits by same user)
      let newTotalViews = 1;
      try {
        const slot = await getDocument('livestreamSlots', streamId);
        if (slot) {
          const currentViews = slot.totalViews || 0;
          newTotalViews = currentViews + 1;
          await updateDocument('livestreamSlots', streamId, {
            totalViews: newTotalViews
          });
        }
      } catch (e) {
        console.log('[listeners] Could not increment totalViews:', e);
      }

      // Count active viewers and broadcast via Pusher
      const activeCount = await countAndBroadcastViewers(streamId, env);

      return new Response(JSON.stringify({
        success: true,
        message: 'Joined as listener',
        totalViews: newTotalViews,
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'leave') {
      // Remove listener
      await deleteDocument('stream-listeners', listenerId);

      // Count active viewers and broadcast via Pusher
      const activeCount = await countAndBroadcastViewers(streamId, env);

      return new Response(JSON.stringify({
        success: true,
        message: 'Left stream',
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'heartbeat') {
      // Update last seen timestamp - use setDocument to create if doesn't exist
      await setDocument('stream-listeners', listenerId, {
        streamId,
        userId,
        userName: userName || 'Viewer',
        avatarUrl: avatarUrl || null,
        lastSeen: Date.now()
      });

      // OPTIMIZATION: Use cached viewer count for heartbeats (saves ~20k Firebase reads/day)
      // Only join/leave actions do fresh counts - heartbeats use cached value
      let activeCount = await getCachedViewerCount(streamId);

      if (activeCount === null) {
        // Cache miss - do a fresh count (this is rare, only on cache expiry)
        activeCount = await countAndBroadcastViewers(streamId, env);
      } else {
        // Broadcast cached count via Pusher (keeps UI updated without Firebase query)
        const channel = `stream-${streamId}`;
        await triggerPusher(channel, 'viewer-update', {
          count: activeCount,
          streamId,
          timestamp: Date.now()
        }, env);
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Heartbeat received',
        activeViewers: activeCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Invalid action. Use: join, leave, or heartbeat' 
      }), { status: 400 });
    }
    
  } catch (error) {
    console.error('Error updating listener:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to update listener status' 
    }), { status: 500 });
  }
};
