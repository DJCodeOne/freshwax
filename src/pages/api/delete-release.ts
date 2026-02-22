// src/pages/api/delete-release.ts
// Deletes a release from Firebase (releases collection + master list)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
import { saDeleteDocument, saUpdateDocument, getServiceAccountKey } from '../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { requireAdminAuth, isAdmin } from '../../lib/admin';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const deleteReleaseSchema = z.object({
  releaseId: z.string().min(1),
});

const logger = createLogger('delete-release');

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit: destructive operations - 3 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-release:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Initialize Firebase environment
    const env = locals.runtime.env || {};


    const body = await request.json();

    const parsed = deleteReleaseSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { releaseId } = parsed.data;

    logger.info(`[delete-release] Deleting: ${releaseId}`);

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      logger.error('[delete-release] Service account not configured');
      return ApiErrors.serverError('Service account not configured');
    }

    // Verify release exists
    const releaseDoc = await getDocument('releases', releaseId);

    if (!releaseDoc) {
      return ApiErrors.notFound('Release not found');
    }

    const releaseData = releaseDoc;

    // Verify ownership: authenticated user must own the release or be a super admin
    const { userId: currentUserId } = await verifyRequestUser(request);
    if (currentUserId) {
      const isOwner = releaseData.submitterId === currentUserId || releaseData.userId === currentUserId;
      if (!isOwner) {
        const userIsAdmin = await isAdmin(currentUserId);
        if (!userIsAdmin) {
          return ApiErrors.forbidden('Not authorized to delete this release');
        }
      }
    }

    // Delete the release document using service account auth
    await saDeleteDocument(serviceAccountKey, projectId, 'releases', releaseId);

    // Delete associated tracks
    try {
      const tracks = await queryCollection('tracks', {
        filters: [{ field: 'releaseId', op: 'EQUAL', value: releaseId }],
        skipCache: true
      });

      if (tracks.length > 0) {
        // Delete each track individually using service account auth
        for (const track of tracks) {
          await saDeleteDocument(serviceAccountKey, projectId, 'tracks', track.id);
        }
        logger.info(`[delete-release] Deleted ${tracks.length} associated tracks`);
      }
    } catch (error: unknown) {
      logger.warn('[delete-release] Could not delete tracks:', error);
    }

    // Remove from master list
    try {
      const masterListDoc = await getDocument('system', 'releases-master');

      if (masterListDoc) {
        const releasesList = masterListDoc.releases || [];
        const updatedReleases = releasesList.filter((r: Record<string, unknown>) => r.id !== releaseId);

        await saUpdateDocument(serviceAccountKey, projectId, 'system', 'releases-master', {
          releases: updatedReleases,
          totalReleases: updatedReleases.length,
          lastUpdated: new Date().toISOString()
        });
      }
    } catch (error: unknown) {
      logger.warn('[delete-release] Could not update master list:', error);
    }

    // Invalidate KV cache for releases list so all edge workers serve fresh data
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => {});
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => {});

    logger.info(`[delete-release] Deleted: ${releaseData?.artistName} - ${releaseData?.releaseName}`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Release deleted successfully',
      releaseId: releaseId,
      releaseName: releaseData?.releaseName,
      artistName: releaseData?.artistName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('[delete-release] Error:', error instanceof Error ? error.message : 'Unknown error');

    return ApiErrors.serverError('Internal server error');
  }
};