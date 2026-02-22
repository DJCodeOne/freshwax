// src/pages/api/update-release.ts
// Firebase-based release update API - uses service account for writes
import { z } from 'zod';
import { getDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { saUpdateDocument, getServiceAccountKey } from '../../lib/firebase-service-account';
import { requireAdminAuth, isAdmin } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { d1UpsertRelease } from '../../lib/d1-catalog';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const updateReleaseSchema = z.object({
  id: z.string().min(1),
  idToken: z.string().optional(),
  adminKey: z.string().optional(),
}).passthrough();

export const prerender = false;

const logger = createLogger('update-release');

export async function POST({ request, locals }: { request: Request; locals: App.Locals }) {
  logger.info('[update-release] POST request received');

  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-release:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  let updates: Record<string, unknown>;
  try {
    updates = await request.json();
    logger.info('[update-release] Request body:', JSON.stringify(updates, null, 2));
  } catch (e: unknown) {
    return ApiErrors.badRequest('Invalid JSON body');
  }

  // Admin authentication required - pass body data for adminKey check
  const authError = await requireAdminAuth(request, locals, updates);
  if (authError) return authError;

  try {
    const env = locals?.runtime?.env || {};

    // Initialize Firebase environment for reads


    const parsed = updateReleaseSchema.safeParse(updates);
    if (!parsed.success) {
      logger.error('[update-release] Invalid request');
      return ApiErrors.badRequest('Invalid request');
    }

    const { id, idToken, adminKey, ...updateData } = parsed.data;

    logger.info('[update-release] Updating release:', id);

    // Get release from Firestore
    const releaseDoc = await getDocument('releases', id);

    if (!releaseDoc) {
      logger.error('[update-release] Release not found:', id);
      return ApiErrors.notFound('Release not found');
    }

    // Verify ownership: authenticated user must own the release or be a super admin
    const { userId: currentUserId } = await verifyRequestUser(request);
    if (currentUserId) {
      const isOwner = releaseDoc.submitterId === currentUserId || releaseDoc.userId === currentUserId;
      if (!isOwner) {
        const userIsAdmin = await isAdmin(currentUserId);
        if (!userIsAdmin) {
          return ApiErrors.forbidden('Not authorized to edit this release');
        }
      }
    }

    // Clean up undefined values (Firestore doesn't like them)
    const cleanedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updateData)) {
      if (value !== undefined) {
        cleanedData[key] = value;
      }
    }

    // Add updatedAt timestamp
    cleanedData.updatedAt = new Date().toISOString();

    // Sync pricing object when price fields are updated
    if (cleanedData.pricePerSale !== undefined || cleanedData.trackPrice !== undefined) {
      const existingPricing = releaseDoc.pricing || {};
      cleanedData.pricing = {
        ...existingPricing,
        digital: cleanedData.pricePerSale ?? existingPricing.digital ?? 0,
        track: cleanedData.trackPrice ?? existingPricing.track ?? 0
      };
    }

    // Validate NYOP fields
    if (cleanedData.nyopEnabled !== undefined) {
      // Ensure boolean
      cleanedData.nyopEnabled = !!cleanedData.nyopEnabled;
    }
    if (cleanedData.nyopMinPrice !== undefined) {
      // Ensure non-negative number
      const minPrice = parseFloat(cleanedData.nyopMinPrice);
      cleanedData.nyopMinPrice = isNaN(minPrice) ? 0 : Math.max(0, minPrice);
    }
    if (cleanedData.nyopSuggestedPrice !== undefined) {
      // Ensure non-negative number
      const suggestedPrice = parseFloat(cleanedData.nyopSuggestedPrice);
      cleanedData.nyopSuggestedPrice = isNaN(suggestedPrice) ? null : Math.max(0, suggestedPrice);
    }

    // Handle per-track updates (Featured, Remixer, BPM, Key)
    if (cleanedData.trackUpdates && Array.isArray(cleanedData.trackUpdates)) {
      const existingTracks = releaseDoc.tracks || [];
      const updatedTracks = existingTracks.map((track: Record<string, unknown>, idx: number) => {
        const trackUpdate = (cleanedData.trackUpdates as Record<string, unknown>[]).find((t: Record<string, unknown>) => t.index === idx);
        if (trackUpdate) {
          return {
            ...track,
            featured: trackUpdate.featured ?? track.featured,
            remixer: trackUpdate.remixer ?? track.remixer,
            bpm: trackUpdate.bpm ?? track.bpm,
            key: trackUpdate.key ?? track.key
          };
        }
        return track;
      });
      cleanedData.tracks = updatedTracks;
      delete cleanedData.trackUpdates; // Remove trackUpdates from the data to save
    }

    logger.info('[update-release] Cleaned data:', JSON.stringify(cleanedData, null, 2));

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      logger.error('[update-release] Service account not configured');
      return ApiErrors.serverError('Service account not configured');
    }

    // Update in Firestore using service account auth
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', id, cleanedData);
    logger.info('[update-release] Updated in Firestore');

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        // Get the full updated document for D1
        const updatedDoc = await getDocument('releases', id);
        if (updatedDoc) {
          await d1UpsertRelease(db, id, updatedDoc);
          logger.info('[update-release] Also updated in D1');
        }
      } catch (d1Error: unknown) {
        // Log D1 error but don't fail the request
        logger.error('[update-release] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Also update the master list
    try {
      const masterListDoc = await getDocument('system', 'releases-master');

      if (masterListDoc) {
        const releasesList = masterListDoc.releases || [];

        // Find and update the release in master list
        const releaseIndex = releasesList.findIndex((r: Record<string, unknown>) => r.id === id);
        if (releaseIndex >= 0) {
          // Update summary fields in master list
          releasesList[releaseIndex] = {
            ...releasesList[releaseIndex],
            title: cleanedData.title || releasesList[releaseIndex].title,
            artist: cleanedData.artist || releasesList[releaseIndex].artist,
            coverUrl: cleanedData.coverUrl || releasesList[releaseIndex].coverUrl,
            published: cleanedData.published !== undefined ? cleanedData.published : releasesList[releaseIndex].published,
            releaseDate: cleanedData.releaseDate || releasesList[releaseIndex].releaseDate,
            updatedAt: cleanedData.updatedAt
          };

          await saUpdateDocument(serviceAccountKey, projectId, 'system', 'releases-master', {
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          });

          logger.info('[update-release] Updated master list');
        }
      }
    } catch (error: unknown) {
      logger.error('[update-release] Warning: Could not update master list:', error);
      // Don't fail the whole operation if master list update fails
    }

    // Invalidate KV cache for releases list so all edge workers serve fresh data
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => {});
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => {});

    logger.info('[update-release] Success - Update complete');

    return successResponse({ message: 'Release updated successfully',
      id: id });

  } catch (error: unknown) {
    logger.error('[update-release] Critical error:', error instanceof Error ? error.message : String(error));
    logger.error('[update-release] Stack:', error instanceof Error ? error.stack : undefined);

    return ApiErrors.serverError('Internal server error');
  }
}