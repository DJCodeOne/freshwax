// src/pages/api/admin/cleanup-duplicates.ts
// Batch delete duplicate releases: Firestore doc, tracks, master list, R2 folder, D1, KV cache

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection } from '../../../lib/firebase-rest';
import { saDeleteDocument, saUpdateDocument } from '../../../lib/firebase-service-account';
import { getAdminFirebaseContext } from '../../../lib/firebase/admin-context';
import { checkRateLimit, delay, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { TIMEOUTS } from '../../../lib/timeouts';
import { requireAdminAuth } from '../../../lib/admin';
import { invalidateReleasesKVCache } from '../../../lib/kv-cache';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('cleanup-duplicates');

export const prerender = false;

const cleanupSchema = z.object({
  releaseIds: z.array(z.string().min(1)).min(1).max(50),
});

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`cleanup-duplicates:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const env = locals.runtime.env;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parsed = cleanupSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request: releaseIds must be an array of 1-50 strings');
    }

    const { releaseIds } = parsed.data;

    const fbCtx = getAdminFirebaseContext(locals);
    if (fbCtx instanceof Response) return fbCtx;
    const { projectId, saKey: serviceAccountKey } = fbCtx;

    const r2: R2Bucket = locals.runtime.env.R2;
    const db = locals.runtime.env.DB as D1Database;

    const results: Array<{ id: string; success: boolean; error?: string }> = [];

    // --- Batch-fetch: get all release documents and tracks in parallel ---
    const releaseDocMap = new Map<string, Record<string, unknown>>();
    const tracksByRelease = new Map<string, Record<string, unknown>[]>();

    const fetchPromises: Promise<void>[] = [];

    // Fetch all release documents in parallel
    for (const releaseId of releaseIds) {
      fetchPromises.push(
        getDocument('releases', releaseId)
          .then((doc) => { if (doc) releaseDocMap.set(releaseId, doc); })
          .catch(() => { /* Lookup error — will be treated as not found */ })
      );
    }

    // Fetch tracks for all releases in parallel
    for (const releaseId of releaseIds) {
      fetchPromises.push(
        queryCollection('tracks', {
          filters: [{ field: 'releaseId', op: 'EQUAL', value: releaseId }],
          skipCache: true
        })
          .then((tracks) => { tracksByRelease.set(releaseId, tracks); })
          .catch(() => { /* Ignore track lookup errors */ })
      );
    }

    // Fetch master list once (shared across all deletions)
    let masterListDoc: Record<string, unknown> | null = null;
    fetchPromises.push(
      getDocument('system', 'releases-master')
        .then((doc) => { masterListDoc = doc; })
        .catch(() => { /* Ignore master list lookup error */ })
    );

    await Promise.all(fetchPromises);

    log.info(`[cleanup] Pre-fetched ${releaseDocMap.size} releases, ${tracksByRelease.size} track sets`);

    // --- Process deletions sequentially (safer for Firestore consistency) ---
    for (const releaseId of releaseIds) {
      try {
        // 1. Check pre-fetched release doc
        const releaseDoc = releaseDocMap.get(releaseId);
        if (!releaseDoc) {
          results.push({ id: releaseId, success: false, error: 'Not found' });
          continue;
        }

        // 2. Delete Firestore release document
        await saDeleteDocument(serviceAccountKey, projectId, 'releases', releaseId);

        // 3. Delete associated tracks (from pre-fetched data)
        try {
          const tracks = tracksByRelease.get(releaseId) || [];
          for (const track of tracks) {
            await saDeleteDocument(serviceAccountKey, projectId, 'tracks', track.id);
          }
        } catch (error: unknown) {
          log.warn(`Could not delete tracks for ${releaseId}:`, error);
        }

        // 4. Remove from master list (use pre-fetched master list)
        try {
          if (masterListDoc) {
            const releasesList = masterListDoc.releases || [];
            const updatedReleases = (releasesList as Record<string, unknown>[]).filter((r: Record<string, unknown>) => r.id !== releaseId);
            if (updatedReleases.length !== (releasesList as Record<string, unknown>[]).length) {
              await saUpdateDocument(serviceAccountKey, projectId, 'system', 'releases-master', {
                releases: updatedReleases,
                totalReleases: updatedReleases.length,
                lastUpdated: new Date().toISOString()
              });
              // Update local copy so subsequent iterations see the removal
              masterListDoc.releases = updatedReleases;
            }
          }
        } catch (error: unknown) {
          log.warn(`Could not update master list for ${releaseId}:`, error);
        }

        // 5. Delete R2 folder
        const r2FolderName = (releaseDoc.r2FolderName || releaseId) as string;
        const prefix = `releases/${r2FolderName}/`;
        try {
          const keys: string[] = [];
          let cursor: string | undefined;
          let truncated = true;
          while (truncated) {
            const listResult = await r2.list({ prefix, cursor });
            for (const obj of listResult.objects) {
              keys.push(obj.key);
            }
            truncated = listResult.truncated;
            cursor = listResult.truncated ? listResult.cursor : undefined;
          }
          if (keys.length > 0) {
            await r2.delete(keys);
          }
        } catch (error: unknown) {
          log.warn(`Could not delete R2 folder for ${releaseId}:`, error);
        }

        // 6. D1 cleanup
        if (db) {
          try {
            await db.prepare('DELETE FROM releases_v2 WHERE id = ?').bind(releaseId).run();
          } catch (error: unknown) {
            log.warn(`Could not delete D1 entry for ${releaseId}:`, error);
          }
        }

        log.info(`Deleted duplicate: ${releaseDoc.artistName} - ${releaseDoc.releaseName} (${releaseId})`);
        results.push({ id: releaseId, success: true });

      } catch (error: unknown) {
        log.error(`Failed to delete ${releaseId}:`, error);
        log.error(`Failed to delete release ${releaseId}:`, error);
        results.push({ id: releaseId, success: false, error: 'Deletion failed' });
      }

      // Delay between operations
      await delay(TIMEOUTS.POLL);
    }

    // 7. Invalidate KV cache
    await invalidateReleasesKVCache();

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return successResponse({
      message: `Deleted ${succeeded} release(s)${failed > 0 ? `, ${failed} failed` : ''}`,
      results
    });

  } catch (error: unknown) {
    log.error('Cleanup error:', error);
    return ApiErrors.serverError('Internal server error');
  }
};
