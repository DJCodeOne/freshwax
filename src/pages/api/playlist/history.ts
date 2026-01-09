// src/pages/api/playlist/history.ts
// Server-side playlist history - shared across all users for auto-play
// NOW USES CLOUDFLARE KV - NO MORE FIREBASE READS!

import type { APIContext } from 'astro';

const KV_HISTORY_KEY = 'playlist-history';
const MAX_HISTORY_SIZE = 500;

function getKV(locals: any): any {
  return (locals as any).runtime?.env?.CACHE;
}

interface HistoryItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  playedAt: string;
  addedBy?: string;
  addedByName?: string;
}

// GET - Fetch playlist history from KV (NO FIREBASE!)
export async function GET({ locals }: APIContext) {
  try {
    const kv = getKV(locals);
    if (!kv) {
      return new Response(JSON.stringify({
        success: false,
        error: 'KV storage not available',
        items: []
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Read from KV - single key, no chunks needed
    const data = await kv.get(KV_HISTORY_KEY, 'json');

    const items = data?.items || [];

    return new Response(JSON.stringify({
      success: true,
      items,
      count: items.length
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=60' // History doesn't change often
      }
    });
  } catch (error: any) {
    console.error('[PlaylistHistory] GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      items: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// POST - Add item to history (called when track starts playing)
// This is a non-critical operation - if it fails, playback should continue
export async function POST({ request, locals }: APIContext) {
  try {
    const kv = getKV(locals);
    if (!kv) {
      return new Response(JSON.stringify({
        success: false,
        error: 'KV storage not available'
      }), {
        status: 200, // Non-critical
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { item } = body;

    if (!item || !item.url) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing item or URL'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get current history from KV
    let history: HistoryItem[] = [];
    try {
      const data = await kv.get(KV_HISTORY_KEY, 'json');
      if (data && data.items) {
        history = data.items;
      }
    } catch (readError: any) {
      console.warn('[PlaylistHistory] Could not read existing history:', readError.message);
    }

    // Check if URL already exists - update timestamp and move to front
    const existingIndex = history.findIndex(h => h.url === item.url);
    if (existingIndex >= 0) {
      const existing = history.splice(existingIndex, 1)[0];
      existing.playedAt = new Date().toISOString();
      existing.title = item.title || existing.title;
      existing.thumbnail = item.thumbnail || existing.thumbnail;
      history.unshift(existing);
    } else {
      // Add new item to front
      const newItem: HistoryItem = {
        id: item.id || Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
        url: item.url,
        platform: item.platform,
        embedId: item.embedId,
        title: item.title,
        thumbnail: item.thumbnail,
        playedAt: new Date().toISOString(),
        addedBy: item.addedBy,
        addedByName: item.addedByName
      };
      history.unshift(newItem);
    }

    // Trim to max size
    if (history.length > MAX_HISTORY_SIZE) {
      history = history.slice(0, MAX_HISTORY_SIZE);
    }

    // Save to KV
    await kv.put(KV_HISTORY_KEY, JSON.stringify({
      items: history,
      lastUpdated: new Date().toISOString()
    }));

    return new Response(JSON.stringify({
      success: true,
      count: history.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[PlaylistHistory] POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 200, // Non-critical operation
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// DELETE - Remove blocked/unavailable video from history
// This prevents the video from being auto-played again
export async function DELETE({ request, locals }: APIContext) {
  try {
    const kv = getKV(locals);
    if (!kv) {
      return new Response(JSON.stringify({
        success: false,
        error: 'KV storage not available'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { url, embedId, reason } = body;

    if (!url) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing URL'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[PlaylistHistory] Removing blocked video: ${url} (reason: ${reason})`);

    // Read from KV
    const data = await kv.get(KV_HISTORY_KEY, 'json');

    if (!data || !data.items) {
      return new Response(JSON.stringify({
        success: true,
        removed: false,
        count: 0,
        message: 'Video not found in history'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const originalLength = data.items.length;
    const filteredItems = data.items.filter((item: HistoryItem) =>
      item.url !== url && (embedId ? item.embedId !== embedId : true)
    );

    const totalRemoved = originalLength - filteredItems.length;

    if (totalRemoved > 0) {
      // Save filtered list back to KV
      await kv.put(KV_HISTORY_KEY, JSON.stringify({
        items: filteredItems,
        lastUpdated: new Date().toISOString()
      }));
      console.log(`[PlaylistHistory] Removed ${totalRemoved} item(s)`);
    }

    return new Response(JSON.stringify({
      success: true,
      removed: totalRemoved > 0,
      count: totalRemoved,
      message: totalRemoved > 0
        ? `Removed ${totalRemoved} blocked video(s) from history`
        : 'Video not found in history'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[PlaylistHistory] DELETE error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
