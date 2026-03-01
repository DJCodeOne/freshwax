// src/pages/api/admin/backfill-followers.ts
// One-time admin endpoint — scans all users to build follower_counts table
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { acquireCronLock, releaseCronLock } from '../../../lib/cron-lock';
import { queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

const log = createLogger('backfill-followers');

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.clone().json().catch(() => null);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = locals.runtime.env;
  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('Database not available');
  }

  const locked = await acquireCronLock(db, 'backfill-followers');
  if (!locked) {
    return ApiErrors.conflict('Backfill already running');
  }

  const start = Date.now();

  try {
    // Fetch all users who have followedArtists
    const users = await queryCollection('users', [], undefined, 10000);

    if (!users || users.length === 0) {
      return successResponse({ message: 'No users found', counted: 0 });
    }

    // Count followers per artist
    const followerMap = new Map<string, number>();

    for (const user of users) {
      const followed = user?.followedArtists;
      if (Array.isArray(followed)) {
        for (const artistId of followed) {
          if (typeof artistId === 'string' && artistId) {
            followerMap.set(artistId, (followerMap.get(artistId) || 0) + 1);
          }
        }
      }
    }

    // Upsert all counts into D1
    let upserted = 0;
    for (const [artistId, count] of followerMap) {
      try {
        await db.prepare(
          `INSERT INTO follower_counts (artist_id, follower_count, last_updated)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(artist_id) DO UPDATE SET
             follower_count = excluded.follower_count,
             last_updated = datetime('now')`
        ).bind(artistId, count).run();
        upserted++;
      } catch (err: unknown) {
        log.error(`Failed to upsert ${artistId}:`, err instanceof Error ? err.message : err);
      }
    }

    const duration = Date.now() - start;
    log.info(`Backfill complete: ${upserted} artists, ${duration}ms`);

    return successResponse({
      usersScanned: users.length,
      artistsCounted: upserted,
      duration: `${duration}ms`,
    });
  } catch (error: unknown) {
    log.error('Backfill error:', error instanceof Error ? error.message : error);
    return ApiErrors.serverError('Backfill failed');
  } finally {
    await releaseCronLock(db, 'backfill-followers');
  }
};

export const GET: APIRoute = async (context) => POST(context);
