// src/pages/api/admin/update-mix.ts
// Admin endpoint to update DJ mix metadata (no ownership check)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { invalidateMixesCache, getDocument } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { initKVCache, kvDelete, CACHE_CONFIG } from '../../../lib/kv-cache';
import { d1UpsertMix } from '../../../lib/d1-catalog';

const log = createLogger('admin/update-mix');

const updateMixSchema = z.object({
  mixId: z.string().min(1),
  title: z.string().max(80).optional().nullable(),
  djName: z.string().max(50).optional().nullable(),
  genre: z.string().max(30).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  artworkUrl: z.string().optional().nullable(),
  sourceUrl: z.string().max(500).optional().nullable(),
  tracklist: z.string().max(2000).optional().nullable(),
  published: z.boolean().optional(),
  allowDownload: z.boolean().optional(),
  featured: z.boolean().optional(),
  durationSeconds: z.union([z.number(), z.string()]).optional().nullable(),
  userId: z.string().optional(),
}).strip();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-mix:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initKVCache(env as { CACHE?: KVNamespace } | undefined);

  try {
    const body = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = updateMixSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { mixId } = parsed.data;

    // Build update object
    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString()
    };

    // Title
    if (body.title !== undefined && body.title !== null) {
      const title = String(body.title || '').slice(0, 80);
      updateData.title = title;
      updateData.name = title;
    }

    // DJ Name
    if (body.djName !== undefined && body.djName !== null) {
      const djName = String(body.djName || '').slice(0, 50);
      updateData.djName = djName;
      updateData.dj_name = djName;
      updateData.displayName = djName;
    }

    // Genre
    if (body.genre !== undefined && body.genre !== null) {
      updateData.genre = String(body.genre || '').slice(0, 30);
    }

    // Description / Shout Outs
    if (body.description !== undefined && body.description !== null) {
      const desc = String(body.description || '').slice(0, 500);
      updateData.description = desc;
      updateData.shoutOuts = desc;
    }

    // Artwork URL
    if (body.artworkUrl !== undefined && body.artworkUrl !== null) {
      updateData.artworkUrl = body.artworkUrl || '';
      updateData.imageUrl = body.artworkUrl || '';
      updateData.artwork_url = body.artworkUrl || '';
    }

    // Source URL (external original upload — hearthis.at, soundcloud, etc.)
    // Validated as a real URL when non-empty so we don't render a broken link.
    if (body.sourceUrl !== undefined && body.sourceUrl !== null) {
      const raw = String(body.sourceUrl || '').trim().slice(0, 500);
      if (raw === '') {
        updateData.sourceUrl = '';
      } else {
        try {
          const u = new URL(raw);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return ApiErrors.badRequest('Source URL must be http or https');
          }
          updateData.sourceUrl = u.toString();
        } catch {
          return ApiErrors.badRequest('Invalid source URL');
        }
      }
    }

    // Tracklist
    if (body.tracklist !== undefined && body.tracklist !== null) {
      const tracklistRaw = String(body.tracklist || '').slice(0, 2000);
      const tracklistArray = tracklistRaw.split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map((line: string) => {
          // Remove leading track numbers
          return line.replace(/^\d+[\.\)\:\-]?\s*[-\u2013\u2014]?\s*/, '').trim();
        })
        .filter((line: string) => line.length > 0);

      updateData.tracklist = tracklistRaw;
      updateData.tracklistArray = tracklistArray;
      updateData.trackCount = tracklistArray.length;
    }

    // Published status
    if (body.published !== undefined) {
      updateData.published = !!body.published;
    }

    // Allow downloads
    if (body.allowDownload !== undefined) {
      updateData.allowDownload = !!body.allowDownload;
    }

    // Featured
    if (body.featured !== undefined) {
      updateData.featured = !!body.featured;
    }

    // Duration (in seconds)
    if (body.durationSeconds !== undefined && body.durationSeconds !== null) {
      const secs = parseInt(body.durationSeconds, 10) || 0;
      updateData.durationSeconds = secs;
      // Format as MM:SS or H:MM:SS
      const hours = Math.floor(secs / 3600);
      const mins = Math.floor((secs % 3600) / 60);
      const seconds = secs % 60;
      const formatted = hours > 0
        ? `${hours}:${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${mins}:${String(seconds).padStart(2, '0')}`;
      updateData.duration = formatted;
      updateData.durationFormatted = formatted;
    }

    // User ID (for fixing ownership)
    if (body.userId !== undefined) {
      updateData.userId = body.userId;
    }

    // Use service account for authorized write
    const serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT;
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'dj-mixes', mixId, updateData);

    // Mirror to D1 — the dj-mix page reads from D1 first, so without this
    // the page keeps rendering the pre-update doc. Fetch the freshly-merged
    // Firestore doc and upsert it whole so D1 stays consistent.
    const db = (env as { DB?: D1Database } | undefined)?.DB;
    if (db) {
      try {
        const updated = await getDocument('dj-mixes', mixId);
        if (updated) {
          await d1UpsertMix(db, mixId, updated);
        }
      } catch (d1Err: unknown) {
        log.warn('[update-mix] D1 mirror failed (non-critical):', d1Err);
      }
    }

    // Clear mixes cache so changes appear immediately
    invalidateMixesCache();
    await kvDelete('live-dj-mixes-v2:all', CACHE_CONFIG.DJ_MIXES).catch(() => { /* non-critical: KV cache invalidation */ });

    return successResponse({ message: 'Mix updated successfully',
      updatedFields: Object.keys(updateData) });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to update mix');
  }
};
