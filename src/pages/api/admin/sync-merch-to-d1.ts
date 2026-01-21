// src/pages/api/admin/sync-merch-to-d1.ts
// Sync all merch from Firebase to D1

import type { APIRoute } from 'astro';
import { queryCollection, clearCache } from '../../../lib/firebase-rest';
import { d1UpsertMerch, d1DeleteMerch } from '../../../lib/d1-catalog';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  if (!db) {
    return new Response(JSON.stringify({
      success: false,
      error: 'D1 database not available'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // Clear Firebase cache to get fresh data
    clearCache('merch');

    // Get all merch from Firebase
    const merchItems = await queryCollection('merch', { limit: 500 });
    console.log(`[sync-merch-to-d1] Found ${merchItems.length} items in Firebase`);

    // Get existing D1 merch IDs
    const d1Result = await db.prepare('SELECT id FROM merch').all();
    const d1Ids = new Set((d1Result.results || []).map((r: any) => r.id));
    console.log(`[sync-merch-to-d1] Found ${d1Ids.size} items in D1`);

    // Firebase IDs
    const firebaseIds = new Set(merchItems.map((item: any) => item.id));

    // Delete items in D1 that are not in Firebase
    const toDelete = [...d1Ids].filter(id => !firebaseIds.has(id));
    for (const id of toDelete) {
      await d1DeleteMerch(db, id);
      console.log(`[sync-merch-to-d1] Deleted stale item: ${id}`);
    }

    // Upsert all Firebase items to D1
    let synced = 0;
    for (const item of merchItems) {
      try {
        await d1UpsertMerch(db, item.id, item);
        synced++;
      } catch (e) {
        console.error(`[sync-merch-to-d1] Failed to sync ${item.id}:`, e);
      }
    }

    // Clear caches
    clearCache('merch');
    clearCache('live-merch');

    return new Response(JSON.stringify({
      success: true,
      message: `Synced ${synced} items to D1, deleted ${toDelete.length} stale items`,
      synced,
      deleted: toDelete.length,
      deletedIds: toDelete
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[sync-merch-to-d1] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
