// src/pages/api/admin/sync-mix-stats.ts
// One-time migration: sync Firestore mix stats (plays, downloads, likes) into D1

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { queryCollection } from '../../../lib/firebase-rest';
import { d1UpsertMix } from '../../../lib/d1-catalog';
import { successResponse, errorResponse } from '../../../lib/api-utils';

export const POST: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAdminAuth(request, locals);
  if (authResult) return authResult;

  const db = locals.runtime?.env?.DB;
  if (!db) return errorResponse('D1 not available', 500);

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
        console.error('[sync-mix-stats] Failed to sync mix:', mix.id, e);
      }
    }

    return successResponse({
      total: mixes.length,
      synced,
      failed,
      details
    });
  } catch (error: unknown) {
    console.error('[sync-mix-stats] Error:', error);
    return errorResponse('Migration failed', 500);
  }
};
