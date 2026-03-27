// src/pages/api/admin/sync-mix-stats.ts
// One-time migration: sync Firestore mix stats (plays, downloads, likes) into D1

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { queryCollection } from '../../../lib/firebase-rest';
import { d1UpsertMix } from '../../../lib/d1-catalog';
import { successResponse, ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/sync-mix-stats');

export const POST: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAdminAuth(request, locals);
  if (authResult) return authResult;

  const db = locals.runtime?.env?.DB;
  if (!db) return ApiErrors.serverError('D1 not available');

  try {
    // Fetch all mixes from Firestore (source of truth)
    const mixes = await queryCollection('dj-mixes', {
      orderBy: { field: 'uploadedAt', direction: 'DESCENDING' },
      skipCache: true
    });

    let synced = 0;
    let failed = 0;
    const details: { id: string; title: string; plays: number; downloads: number; likes: number }[] = [];

    for (const mix of mixes) {
      try {
        const id = mix.id;
        if (!id) continue;

        await d1UpsertMix(db, id, mix);
        synced++;

        details.push({
          id,
          title: mix.title || 'Untitled',
          plays: mix.playCount || mix.plays || 0,
          downloads: mix.downloadCount || mix.downloads || 0,
          likes: mix.likeCount || mix.likes || 0
        });
      } catch (e: unknown) {
        failed++;
        log.error('Failed to sync mix:', mix.id, e);
      }
    }

    return successResponse({
      total: mixes.length,
      synced,
      failed,
      details
    });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Migration failed');
  }
};
