// src/pages/api/dj-lobby/presence.ts
// DJ Lobby presence tracking - Pusher-based (no Firebase onSnapshot)
// Replaces client-side Firebase listener with server-mediated Pusher events

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { createHmac, createHash } from 'crypto';

// Pusher configuration (from .env)
const PUSHER_APP_ID = import.meta.env.PUSHER_APP_ID;
const PUSHER_KEY = import.meta.env.PUBLIC_PUSHER_KEY;
const PUSHER_SECRET = import.meta.env.PUSHER_SECRET;
const PUSHER_CLUSTER = import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

// Trigger Pusher event
async function triggerPusher(channel: string, event: string, data: any): Promise<boolean> {
  try {
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });
    
    const bodyMd5 = createHash('md5').update(body).digest('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    
    const params = new URLSearchParams({
      auth_key: PUSHER_KEY,
      auth_timestamp: timestamp,
      auth_version: '1.0',
      body_md5: bodyMd5
    });
    params.sort();
    
    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\n${params.toString()}`;
    const signature = createHmac('sha256', PUSHER_SECRET).update(stringToSign).digest('hex');
    
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
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
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

    // Query Firebase for DJs with recent activity (last 2 minutes)
    const twoMinutesAgo = new Date(Date.now() - 120000);

    const djs = await queryCollection('djLobbyPresence', {
      filters: [{ field: 'lastSeen', op: 'GREATER_THAN', value: twoMinutesAgo }],
      skipCache: true
    });

    // Add odamiMa field for compatibility
    const djsWithOdamiMa = djs.map(dj => ({ ...dj, odamiMa: dj.id }));

    // Cache the result
    setCachedOnlineDjs(djsWithOdamiMa);

    return new Response(JSON.stringify({
      success: true,
      djs: djsWithOdamiMa,
      source: 'firestore'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10'
      }
    });

  } catch (error) {
    console.error('[dj-lobby/presence] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get online DJs'
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
        });

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
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Joined lobby'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'leave': {
        // Delete presence document
        await deleteDocument('djLobbyPresence', userId);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast leave event
        await triggerPusher('dj-lobby', 'dj-left', {
          id: userId,
          timestamp: now.toISOString()
        });

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
        });

        // Broadcast status update if ready state changed
        if (typeof isReady === 'boolean') {
          await triggerPusher('dj-lobby', 'dj-status', {
            id: userId,
            isReady,
            timestamp: now.toISOString()
          });
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

        await updateDocument('djLobbyPresence', userId, updateData);

        // Invalidate cache
        onlineDjsCache.delete('online-djs');

        // Broadcast update
        await triggerPusher('dj-lobby', 'dj-updated', {
          id: userId,
          ...updateData,
          timestamp: now.toISOString()
        });

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
      filters: [{ field: 'lastSeen', op: 'LESS_THAN', value: twoMinutesAgo }],
      skipCache: true
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
        });
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
