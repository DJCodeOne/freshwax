// src/pages/api/playlist/history.ts
// Server-side playlist history - shared across all users for auto-play

import type { APIContext } from 'astro';
import { getDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

const HISTORY_DOC = 'playlistHistory';
const MAX_HISTORY_SIZE = 100;
const MAX_CHUNKS = 10; // Maximum number of history chunks to read

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
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

// GET - Fetch playlist history (reads all chunks)
export async function GET({ locals }: APIContext) {
  try {
    initEnv(locals);

    // Read main document first to check for chunk metadata
    const mainDoc = await getDocument('liveSettings', HISTORY_DOC);

    if (!mainDoc) {
      return new Response(JSON.stringify({
        success: true,
        items: []
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Collect all items from main doc
    let allItems: HistoryItem[] = mainDoc.items || [];

    // Check if there are additional chunks
    const totalChunks = mainDoc.totalChunks || 1;

    if (totalChunks > 1) {
      // Fetch remaining chunks (chunk indices 1, 2, 3, etc.)
      for (let i = 1; i < Math.min(totalChunks, MAX_CHUNKS); i++) {
        try {
          const chunkDoc = await getDocument('liveSettings', `${HISTORY_DOC}_${i}`);
          if (chunkDoc && chunkDoc.items) {
            allItems = allItems.concat(chunkDoc.items);
          }
        } catch (chunkError) {
          console.warn(`[PlaylistHistory] Could not read chunk ${i}:`, chunkError);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      items: allItems,
      totalChunks: totalChunks,
      count: allItems.length
    }), {
      headers: { 'Content-Type': 'application/json' }
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
    initEnv(locals);
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

    // Get current history
    let history: HistoryItem[] = [];
    try {
      const doc = await getDocument('liveSettings', HISTORY_DOC);
      if (doc && doc.items) {
        history = doc.items;
      }
    } catch (readError: any) {
      console.warn('[PlaylistHistory] Could not read existing history:', readError.message);
      // Continue with empty history - we'll create fresh
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

    // Try to save to Firebase - if it fails, return success anyway (non-critical)
    try {
      await setDocument('liveSettings', HISTORY_DOC, { items: history });
      return new Response(JSON.stringify({
        success: true,
        count: history.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (writeError: any) {
      // Write failed (likely permission issue) - log but return 200
      // This is non-critical, local history still works for auto-play
      console.warn('[PlaylistHistory] Could not save to Firebase:', writeError.message);
      return new Response(JSON.stringify({
        success: false,
        warning: 'History not persisted to server (local history still works)',
        error: writeError.message
      }), {
        status: 200, // Return 200 to avoid red console errors
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error: any) {
    console.error('[PlaylistHistory] POST error:', error);
    // Even on unexpected errors, return 200 to not break playback
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 200, // Non-critical operation, don't break playback
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// DELETE - Remove blocked/unavailable video from history
// This prevents the video from being auto-played again
export async function DELETE({ request, locals }: APIContext) {
  try {
    initEnv(locals);
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

    // Track if we removed from any chunk
    let removedFromAny = false;
    let totalRemoved = 0;

    // Read main document first
    const mainDoc = await getDocument('liveSettings', HISTORY_DOC);

    if (mainDoc && mainDoc.items) {
      const totalChunks = mainDoc.totalChunks || 1;

      // Process main document (chunk 0)
      const originalLength = mainDoc.items.length;
      const filteredItems = mainDoc.items.filter((item: HistoryItem) =>
        item.url !== url && (embedId ? item.embedId !== embedId : true)
      );

      if (filteredItems.length < originalLength) {
        removedFromAny = true;
        totalRemoved += originalLength - filteredItems.length;

        // Save updated main document
        await setDocument('liveSettings', HISTORY_DOC, {
          items: filteredItems,
          totalChunks: totalChunks,
          lastUpdated: new Date().toISOString()
        });
        console.log(`[PlaylistHistory] Removed ${originalLength - filteredItems.length} item(s) from main chunk`);
      }

      // Process additional chunks
      for (let i = 1; i < Math.min(totalChunks, MAX_CHUNKS); i++) {
        try {
          const chunkDoc = await getDocument('liveSettings', `${HISTORY_DOC}_${i}`);
          if (chunkDoc && chunkDoc.items) {
            const chunkOriginalLength = chunkDoc.items.length;
            const chunkFiltered = chunkDoc.items.filter((item: HistoryItem) =>
              item.url !== url && (embedId ? item.embedId !== embedId : true)
            );

            if (chunkFiltered.length < chunkOriginalLength) {
              removedFromAny = true;
              totalRemoved += chunkOriginalLength - chunkFiltered.length;

              await setDocument('liveSettings', `${HISTORY_DOC}_${i}`, {
                items: chunkFiltered,
                lastUpdated: new Date().toISOString()
              });
              console.log(`[PlaylistHistory] Removed ${chunkOriginalLength - chunkFiltered.length} item(s) from chunk ${i}`);
            }
          }
        } catch (chunkError) {
          console.warn(`[PlaylistHistory] Could not process chunk ${i}:`, chunkError);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      removed: removedFromAny,
      count: totalRemoved,
      message: removedFromAny
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
