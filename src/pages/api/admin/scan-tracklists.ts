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
    // Fetch all mixes that have tracklists from D1
    const { results: mixes } = await db.prepare(
      `SELECT id, user_id, dj_name, tracklist FROM d1_mixes
       WHERE tracklist IS NOT NULL AND tracklist != ''
       ORDER BY created_at DESC`
    ).all();

    if (!mixes || mixes.length === 0) {
      return successResponse({ message: 'No mixes with tracklists found', scanned: 0, matched: 0 });
    }

    let totalScanned = 0;
    let totalMatched = 0;

    for (const mix of mixes) {
      const mixId = mix.id as string;
      const djUserId = (mix.user_id as string) || null;
      const djName = (mix.dj_name as string) || 'Unknown DJ';
      const tracklistRaw = mix.tracklist as string;

      // Parse tracklist — could be JSON array or newline-separated string
      let tracklistLines: string[] = [];
      try {
        const parsed = JSON.parse(tracklistRaw);
        if (Array.isArray(parsed)) {
          tracklistLines = parsed.map((t: unknown) => String(t));
        }
      } catch {
        // Not JSON — split by newlines
        tracklistLines = tracklistRaw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      }

      if (tracklistLines.length === 0) continue;

      const result = await scanTracklistForSupport(db, mixId, djUserId, djName, tracklistLines);
      totalScanned++;
      totalMatched += result.matched;
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
