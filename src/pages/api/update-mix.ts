// src/pages/api/update-mix.ts
// API endpoint to update mix description and backfill userId - uses Firebase REST API
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { d1UpsertMix } from '../../lib/d1-catalog';
import { isAdmin } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { kvDelete } from '../../lib/kv-cache';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('update-mix');

const UpdateMixSchema = z.object({
  mixId: z.string().min(1).max(500),
  title: z.string().max(500).nullish(),
  description: z.string().max(5000).nullish(),
  tracklist: z.string().max(10000).nullish(),
  artworkUrl: z.string().max(2000).nullish(),
  partnerId: z.string().max(500).nullish(),
}).passthrough();

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-mix:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    // SECURITY: Verify authentication via token (not cookies which are spoofable)
    const { userId: currentUserId, error: authError } = await verifyRequestUser(request);
    if (!currentUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();
    const parseResult = UpdateMixSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { mixId, title, description, tracklist, artworkUrl, partnerId } = parseResult.data;

    // Get the mix
    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      return ApiErrors.notFound('Mix not found');
    }

    // Check ownership - allow if userId matches
    const isOwner = mixData?.userId === currentUserId;

    // Orphaned mixes (no userId) can only be backfilled by admins
    let canBackfillOwnership = false;
    if (!mixData?.userId && currentUserId) {
      canBackfillOwnership = await isAdmin(currentUserId);
    }

    if (!isOwner && !canBackfillOwnership) {
      return ApiErrors.forbidden('Not authorized to edit this mix');
    }

    // Build update object
    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString()
    };

    // Update title if provided (max 50 chars)
    if (title !== undefined) {
      updateData.title = title.slice(0, 50);
      updateData.name = title.slice(0, 50);
    }

    if (description !== undefined) {
      updateData.description = description.slice(0, 150);
      updateData.shoutOuts = description.slice(0, 150);
    }

    // Update artwork URL if provided (from artwork upload)
    if (artworkUrl) {
      updateData.artwork_url = artworkUrl;
      updateData.artworkUrl = artworkUrl;
      updateData.imageUrl = artworkUrl;
    }

    // Handle tracklist update - strip leading track numbers for consistent display
    if (tracklist !== undefined) {
      const tracklistRaw = tracklist.slice(0, 1500);
      const tracklistArray = tracklistRaw.split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map((line: string) => {
          // Remove leading track numbers in formats like: "1.", "01.", "1)", "1:", "1 -", etc.
          return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
        })
        .filter((line: string) => line.length > 0);

      updateData.tracklist = tracklistRaw;
      updateData.tracklistArray = tracklistArray;
      updateData.trackCount = tracklistArray.length;
    }

    // Backfill userId if missing
    if (!mixData?.userId && currentUserId) {
      updateData.userId = currentUserId;
    }

    try {
      await updateDocument('dj-mixes', mixId, updateData);
    } catch (updateError: unknown) {
      log.error('[update-mix] updateDocument error:', updateError);
      return ApiErrors.serverError('Database update failed');
    }

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        // Get the full updated document for D1
        const updatedMix = await getDocument('dj-mixes', mixId);
        if (updatedMix) {
          await d1UpsertMix(db, mixId, updatedMix);
        }
      } catch (d1Error: unknown) {
        // Log D1 error but don't fail the request
        log.error('[update-mix] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Invalidate KV cache for mixes list so all edge workers serve fresh data
    const MIXES_CACHE = { prefix: 'mixes' };
    await kvDelete('public:50', MIXES_CACHE).catch(() => {});
    await kvDelete('public:20', MIXES_CACHE).catch(() => {});
    await kvDelete('public:100', MIXES_CACHE).catch(() => {});

    return successResponse({ message: 'Mix updated successfully' });

  } catch (error: unknown) {
    log.error('Error updating mix:', error);
    return ApiErrors.serverError('Failed to update mix');
  }
};
