// src/pages/api/delete-release.ts
// Deletes a release from Firebase (releases collection + master list)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
import { saDeleteDocument, saUpdateDocument, getServiceAccountKey } from '../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { requireAdminAuth } from '../../lib/admin';
import { invalidateReleasesKVCache } from '../../lib/kv-cache';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const deleteReleaseSchema = z.object({
  releaseId: z.string().min(1),
  idToken: z.string().optional(),
}).passthrough();

const log = createLogger('delete-release');

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: destructive operations - 3 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-release:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return ApiErrors.badRequest('Invalid JSON body');
  }

  // Try admin auth first; fall back to ownership-based auth so artists can
  // delete their own releases without being site admins.
  const adminAuthError = await requireAdminAuth(request, locals, body);
  const isAdminUser = !adminAuthError;

  try {
    // Initialize Firebase environment
    const env = locals.runtime.env || {};

    const parsed = deleteReleaseSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { releaseId, idToken } = parsed.data;

    log.info(`[delete-release] Deleting: ${releaseId}`, isAdminUser ? '(admin)' : '(ownership check)');

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      log.error('[delete-release] Service account not configured');
      return ApiErrors.serverError('Service account not configured');
    }

    // Verify release exists
    const releaseDoc = await getDocument('releases', releaseId);

    if (!releaseDoc) {
      return ApiErrors.notFound('Release not found');
    }

    const releaseData = releaseDoc;

    // Non-admin path: verify the request user owns this release
    if (!isAdminUser) {
      let currentUserId: string | null = null;
      const verifyResult = await verifyRequestUser(request);
      currentUserId = verifyResult.userId;

      // Fallback: token sent in body instead of Authorization header
      if (!currentUserId && typeof idToken === 'string' && idToken.length > 0) {
        try {
          const { verifyUserToken } = await import('../../lib/firebase-rest');
          currentUserId = await verifyUserToken(idToken);
        } catch (e: unknown) {
          log.warn('[delete-release] body idToken verification failed:', e);
        }
      }

      if (!currentUserId) {
        return adminAuthError!;
      }

      const isOwner = releaseData.submitterId === currentUserId
        || releaseData.userId === currentUserId
        || releaseData.uploadedBy === currentUserId
        || releaseData.submitterEmail === verifyResult.email;
      if (!isOwner) {
        return ApiErrors.forbidden('Not authorized to delete this release');
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
        log.info(`[delete-release] Deleted ${tracks.length} associated tracks`);
      }
    } catch (error: unknown) {
      log.warn('[delete-release] Could not delete tracks:', error);
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
      log.warn('[delete-release] Could not update master list:', error);
    }

    // Invalidate KV cache for releases list so all edge workers serve fresh data
    await invalidateReleasesKVCache();

    log.info(`[delete-release] Deleted: ${releaseData?.artistName} - ${releaseData?.releaseName}`);

    return successResponse({ message: 'Release deleted successfully',
      releaseId: releaseId,
      releaseName: releaseData?.releaseName,
      artistName: releaseData?.artistName });

  } catch (error: unknown) {
    log.error('[delete-release] Error:', error instanceof Error ? error.message : 'Unknown error');

    return ApiErrors.serverError('Internal server error');
  }
};