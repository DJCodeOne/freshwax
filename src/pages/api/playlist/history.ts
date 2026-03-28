// src/pages/api/playlist/history.ts
// Server-side playlist history - shared across all users for auto-play
// NOW USES CLOUDFLARE KV - NO MORE FIREBASE READS!
// AUTH: Intentionally public — this is a shared global playlist history for the
// livestream auto-play feature. All users (including anonymous) contribute to it.
// Rate limited. No user-specific data is stored or exposed.

import type { APIContext } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors, successResponse, errorResponse } from '../../../lib/api-utils';
import { KV_TTL } from '../../../lib/timeouts';

const postSchema = z.object({
  item: z.object({
    id: z.string().optional(),
    url: z.string().url(),
    platform: z.string(),
    embedId: z.string().optional(),
    title: z.string().optional(),
    thumbnail: z.string().optional(),
    addedBy: z.string().optional(),
    addedByName: z.string().optional(),
  }),
});

const deleteSchema = z.object({
  url: z.string().url(),
  embedId: z.string().optional(),
  reason: z.string().optional(),
});

const log = createLogger('[playlist-history]');

const KV_HISTORY_KEY = 'playlist-history';
const MAX_HISTORY_SIZE = 500;

function getKV(locals: App.Locals): KVNamespace | undefined {
  return locals.runtime.env?.CACHE;
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
export async function GET({ request, locals }: APIContext) {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-history:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const kv = getKV(locals);
    if (!kv) {
      return ApiErrors.serverError('KV storage not available');
    }

    // Read from KV - single key, no chunks needed
    const data = await kv.get(KV_HISTORY_KEY, 'json');

    const items = data?.items || [];

    // History doesn't change often
    return successResponse({ items, count: items.length }, 200, {
      headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60' }
    });
  } catch (error: unknown) {
    log.error('GET error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}

// POST - Add item to history (called when track starts playing)
// This is a non-critical operation - if it fails, playback should continue
export async function POST({ request, locals }: APIContext) {
  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rl = checkRateLimit(`playlist-history-write:${clientId}`, RateLimiters.write);
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter!);
  }

  try {
    const kv = getKV(locals);
    if (!kv) {
      return errorResponse('KV storage not available', 200);
    }

    const body = await request.json();
    const parseResult = postSchema.safeParse(body);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { item } = parseResult.data;

    // Get current history from KV
    let history: HistoryItem[] = [];
    try {
      const data = await kv.get(KV_HISTORY_KEY, 'json');
      if (data && data.items) {
        history = data.items;
      }
    } catch (readError: unknown) {
      log.warn('Could not read existing history:', readError instanceof Error ? readError.message : String(readError));
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
    }), { expirationTtl: KV_TTL.ONE_WEEK });

    return successResponse({ count: history.length });
  } catch (error: unknown) {
    log.error('POST error:', error instanceof Error ? error.message : String(error));
    return errorResponse('Internal error', 200);
  }
}

// DELETE - Remove blocked/unavailable video from history
// This prevents the video from being auto-played again
// AUTH: Intentionally public — called by client-side player when a YouTube video is
// detected as blocked/unavailable. Removing broken entries from the shared autoplay
// history benefits all users. Rate limited to 30/min to prevent abuse.
export async function DELETE({ request, locals }: APIContext) {
  // Rate limit: write operations - 30 per minute
  const clientId2 = getClientId(request);
  const rl2 = checkRateLimit(`playlist-history-write:${clientId2}`, RateLimiters.write);
  if (!rl2.allowed) {
    return rateLimitResponse(rl2.retryAfter!);
  }

  try {
    const kv = getKV(locals);
    if (!kv) {
      return ApiErrors.serverError('KV storage not available');
    }

    const body = await request.json();
    const parseResult = deleteSchema.safeParse(body);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { url, embedId, reason } = parseResult.data;

    log.info(`[PlaylistHistory] Removing blocked video: ${url} (reason: ${reason})`);

    // Read from KV
    const data = await kv.get(KV_HISTORY_KEY, 'json');

    if (!data || !data.items) {
      return successResponse({ removed: false, count: 0, message: 'Video not found in history' });
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
      }), { expirationTtl: KV_TTL.ONE_WEEK });
      log.info(`[PlaylistHistory] Removed ${totalRemoved} item(s)`);
    }

    return successResponse({
      removed: totalRemoved > 0,
      count: totalRemoved,
      message: totalRemoved > 0
        ? `Removed ${totalRemoved} blocked video(s) from history`
        : 'Video not found in history'
    });
  } catch (error: unknown) {
    log.error('DELETE error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
}
