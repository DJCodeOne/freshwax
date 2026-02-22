// src/pages/api/admin/sync-merch-to-d1.ts
// Sync all merch from Firebase to D1

import type { APIRoute } from 'astro';
import { queryCollection, clearCache } from '../../../lib/firebase-rest';
import { d1UpsertMerch, d1DeleteMerch } from '../../../lib/d1-catalog';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('[sync-merch-to-d1]');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`sync-merch-to-d1:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = locals.runtime.env;
  const db = env?.DB;

  if (!db) {
    return ApiErrors.serverError('D1 database not available');
  }

  try {
    // Clear Firebase cache to get fresh data
    clearCache('merch');
    clearCache('query');
    clearCache('doc');

    // Get all merch from Firebase (no limit — sync must fetch everything to avoid deleting valid D1 items)
    const merchItems = await queryCollection('merch', { skipCache: true });
    log.info(`[sync-merch-to-d1] Found ${merchItems.length} items in Firebase`);

    // Get existing D1 merch IDs
    const d1Result = await db.prepare('SELECT id FROM merch').all();
    const d1Ids = new Set((d1Result.results || []).map((r: Record<string, unknown>) => r.id));
    log.info(`[sync-merch-to-d1] Found ${d1Ids.size} items in D1`);

    // Firebase IDs
    const firebaseIds = new Set(merchItems.map((item: Record<string, unknown>) => item.id));

    // Delete items in D1 that are not in Firebase
    const toDelete = [...d1Ids].filter(id => !firebaseIds.has(id));
    for (const id of toDelete) {
      await d1DeleteMerch(db, id);
      log.info(`[sync-merch-to-d1] Deleted stale item: ${id}`);
    }

    // Upsert all Firebase items to D1
    let synced = 0;
    const failed: { id: string; name: string; error?: string }[] = [];

    for (const item of merchItems) {
      try {
        const success = await d1UpsertMerch(db, item.id, item);
        if (success) {
          synced++;
        } else {
          failed.push({ id: item.id, name: item.name, error: 'Upsert returned false' });
        }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.error(`[sync-merch-to-d1] Failed to sync ${item.id}:`, e);
        failed.push({ id: item.id, name: item.name, error: errMsg });
      }
    }

    // Clear caches
    clearCache('merch');
    clearCache('live-merch');

    return successResponse({ message: `Synced ${synced} of ${merchItems.length} items to D1, deleted ${toDelete.length} stale items`,
      synced,
      total: merchItems.length,
      failed: failed.length,
      failedItems: failed,
      deleted: toDelete.length,
      deletedIds: toDelete });

  } catch (error: unknown) {
    log.error('[sync-merch-to-d1] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
