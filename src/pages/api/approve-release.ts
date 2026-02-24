// src/pages/api/approve-release.ts
// Approves or rejects pending releases in Firebase
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, invalidateReleasesCache } from '../../lib/firebase-rest';
import { d1UpsertRelease } from '../../lib/d1-catalog';
import { requireAdminAuth } from '../../lib/admin';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';
import { createLogger, errorResponse, successResponse } from '../../lib/api-utils';

export const prerender = false;

const log = createLogger('approve-release');

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase env for write operations (Cloudflare runtime)
  const env = (locals as App.Locals).runtime?.env;

  try {
    const body = await request.json();

    // Admin authentication required
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { releaseId, action } = body as { releaseId?: string; action?: string };

    // Validate input
    if (!releaseId || !action) {
      return errorResponse('releaseId and action are required', 400);
    }

    if (!['approve', 'reject'].includes(action)) {
      return errorResponse('action must be "approve" or "reject"', 400);
    }

    log.info(`[approve-release] ${action} release ${releaseId}`);

    // Get release from Firestore
    const releaseData = await getDocument('releases', releaseId) as Record<string, unknown> | null;

    if (!releaseData) {
      return errorResponse('Release not found', 404);
    }

    // Update release status
    const updateData = {
      status: action === 'approve' ? 'live' : 'rejected',
      published: action === 'approve',
      approvedAt: action === 'approve' ? new Date().toISOString() : null,
      rejectedAt: action === 'reject' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    await updateDocument('releases', releaseId, updateData);

    // Update master list
    try {
      const masterListDoc = await getDocument('system', 'releases-master') as Record<string, unknown> | null;

      if (masterListDoc) {
        const releasesList = (masterListDoc.releases || []) as Array<Record<string, unknown>>;

        const releaseIndex = releasesList.findIndex((r: Record<string, unknown>) => r.id === releaseId);
        if (releaseIndex >= 0) {
          releasesList[releaseIndex] = {
            ...releasesList[releaseIndex],
            status: updateData.status,
            published: updateData.published,
            updatedAt: updateData.updatedAt
          };

          await updateDocument('system', 'releases-master', {
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          });
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error('[approve-release] Warning: Could not update master list:', message);
    }

    // Sync to D1 for immediate visibility
    const db = env?.DB;
    if (db) {
      try {
        const updatedRelease = { ...releaseData, ...updateData };
        await d1UpsertRelease(db, releaseId, updatedRelease);
        log.info('[approve-release] D1 synced');
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log.error('[approve-release] Warning: D1 sync failed:', message);
      }
    }

    // Invalidate in-memory and KV caches to ensure fresh data across all edge workers
    invalidateReleasesCache();
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => { /* KV cache invalidation — non-critical */ });
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => { /* KV cache invalidation — non-critical */ });
    log.info('[approve-release] Cache invalidated');

    log.info(`[approve-release] ${action}d: ${releaseData.artistName} - ${releaseData.releaseName}`);

    return successResponse({ message: `Release ${action}d successfully`,
      releaseId: releaseId,
      status: updateData.status,
      releaseName: releaseData.releaseName,
      artistName: releaseData.artistName });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('[approve-release] Error:', message);

    return errorResponse('Internal server error');
  }
};
