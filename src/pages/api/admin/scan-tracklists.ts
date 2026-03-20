// src/pages/api/admin/scan-tracklists.ts
// Admin endpoint — batch scan all mixes' tracklists for catalog matches
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { scanTracklistForSupport } from '../../../lib/dj-support';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { acquireCronLock, releaseCronLock } from '../../../lib/cron-lock';

export const prerender = false;

const log = createLogger('admin-scan-tracklists');

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.clone().json().catch(() => null);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = locals.runtime.env;
  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('Database not available');
  }

  // Prevent overlapping scans
  const locked = await acquireCronLock(db, 'scan-tracklists');
  if (!locked) {
    return ApiErrors.conflict('Scan already running');
  }

  const start = Date.now();

  try {
    // Fetch all mixes from D1 — tracklist is inside the `data` JSON column as tracklistArray
    const { results: mixes } = await db.prepare(
      `SELECT id, user_id, dj_name, data FROM dj_mixes
       ORDER BY created_at DESC`
    ).all();

    if (!mixes || mixes.length === 0) {
      return successResponse({ message: 'No mixes found', scanned: 0, matched: 0 });
    }

    let totalScanned = 0;
    let totalMatched = 0;

    // Pre-parse all mixes to extract tracklist data, filtering out invalid ones
    const parsedMixes: Array<{ mixId: string; djUserId: string | null; djName: string; tracklistLines: string[] }> = [];
    for (const mix of mixes) {
      const mixId = mix.id as string;
      const djUserId = (mix.user_id as string) || null;
      const djName = (mix.dj_name as string) || 'Unknown DJ';
      const dataRaw = mix.data as string;

      let tracklistLines: string[] = [];
      try {
        const parsed = JSON.parse(dataRaw);
        const tracklistArray = parsed?.tracklistArray;
        if (Array.isArray(tracklistArray)) {
          tracklistLines = tracklistArray
            .map((t: unknown) => String(t).trim())
            .filter((l: string) => l.length > 0);
        }
      } catch {
        log.warn(`Mix ${mixId}: could not parse data JSON`);
        continue;
      }

      if (tracklistLines.length === 0) continue;
      parsedMixes.push({ mixId, djUserId, djName, tracklistLines });
    }

    // Process in batches of 10 to avoid overwhelming the DB
    const batchSize = 10;
    for (let i = 0; i < parsedMixes.length; i += batchSize) {
      const batch = parsedMixes.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(({ mixId, djUserId, djName, tracklistLines }) =>
          scanTracklistForSupport(db, mixId, djUserId, djName, tracklistLines)
        )
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalScanned++;
          totalMatched += result.value.matched;
        } else {
          log.warn('Mix scan failed:', result.reason);
          totalScanned++;
        }
      }
    }

    const duration = Date.now() - start;
    log.info(`Scan complete: ${totalScanned} mixes, ${totalMatched} matches, ${duration}ms`);

    return successResponse({
      scanned: totalScanned,
      matched: totalMatched,
      duration: `${duration}ms`,
    });
  } catch (error: unknown) {
    log.error('Scan error:', error instanceof Error ? error.message : error);
    return ApiErrors.serverError('Tracklist scan failed');
  } finally {
    await releaseCronLock(db, 'scan-tracklists');
  }
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
