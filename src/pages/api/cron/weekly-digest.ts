// src/pages/api/cron/weekly-digest.ts
// Cron job: sends weekly "This Week on FreshWax" digest email to subscribers
// Schedule: 0 10 * * 0 (Sundays at 10:00 UTC)
// Auth: Authorization: Bearer $CRON_SECRET or X-Admin-Key
// Query params: ?preview=true (returns HTML), ?sendTo=email (test send)
import type { APIRoute } from 'astro';
import { acquireCronLock, releaseCronLock } from '../../../lib/cron-lock';
import { ApiErrors, createLogger, successResponse, timingSafeCompare, getAdminKey } from '../../../lib/api-utils';
import { sendResendEmail, logEmailToD1 } from '../../../lib/email';
import { queryCollection } from '../../../lib/firebase-rest';
import { buildWeeklyDigestHtml } from '../../../lib/weekly-digest-template';
import type { DigestRelease, DigestMix, DigestSupport, WeeklyDigestData } from '../../../lib/weekly-digest-template';

export const prerender = false;

const log = createLogger('weekly-digest');

// ============================================
// DATA QUERIES
// ============================================

async function getTopReleases(db: D1Database, since: string): Promise<DigestRelease[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, title, artist_name, image_url, price, plays, likes, downloads
       FROM d1_releases
       WHERE status = 'live' AND created_at >= ?
       ORDER BY (COALESCE(plays,0) * 0.3 + COALESCE(likes,0) * 2 + COALESCE(downloads,0) * 1.5) DESC
       LIMIT 10`
    ).bind(since).all();

    return (results ?? []).map(r => ({
      id: r.id as string,
      title: r.title as string,
      artistName: r.artist_name as string,
      imageUrl: (r.image_url as string) || undefined,
      price: r.price != null ? Number(r.price) : undefined,
      score: (Number(r.plays || 0) * 0.3) + (Number(r.likes || 0) * 2) + (Number(r.downloads || 0) * 1.5),
    }));
  } catch (err: unknown) {
    log.error('Failed to fetch top releases:', err instanceof Error ? err.message : err);
    return [];
  }
}

async function getTopMixes(db: D1Database, since: string): Promise<DigestMix[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, title, dj_name, artwork_url, plays, likes
       FROM d1_mixes
       WHERE created_at >= ?
       ORDER BY (COALESCE(plays,0) * 0.3 + COALESCE(likes,0) * 2) DESC
       LIMIT 5`
    ).bind(since).all();

    return (results ?? []).map(m => ({
      id: m.id as string,
      title: m.title as string,
      djName: m.dj_name as string,
      imageUrl: (m.artwork_url as string) || undefined,
      score: (Number(m.plays || 0) * 0.3) + (Number(m.likes || 0) * 2),
    }));
  } catch (err: unknown) {
    log.error('Failed to fetch top mixes:', err instanceof Error ? err.message : err);
    return [];
  }
}

async function getDjSupportHighlights(db: D1Database, since: string): Promise<DigestSupport[]> {
  try {
    const { results } = await db.prepare(
      `SELECT dj_name, release_title, artist_name, release_id
       FROM dj_support
       WHERE created_at >= ?
       ORDER BY created_at DESC
       LIMIT 10`
    ).bind(since).all();

    return (results ?? []).map(s => ({
      djName: s.dj_name as string,
      releaseTitle: s.release_title as string,
      artistName: s.artist_name as string,
      releaseId: s.release_id as string,
    }));
  } catch (err: unknown) {
    log.error('Failed to fetch DJ support highlights:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ============================================
// SUBSCRIBER QUERY
// ============================================

async function getDigestSubscribers(): Promise<Array<{ email: string; name: string }>> {
  try {
    const users = await queryCollection('users', [
      { field: 'newsletterSubscribed', op: '==', value: true },
    ], undefined, 5000);

    return (users || [])
      .filter(u => u?.email && typeof u.email === 'string')
      .map(u => ({
        email: u.email as string,
        name: (u.displayName || u.name || '') as string,
      }));
  } catch (err: unknown) {
    log.error('Failed to fetch subscribers:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ============================================
// MAIN HANDLER
// ============================================

export const POST: APIRoute = async ({ request, locals }) => {
  // Auth check
  const env = locals.runtime.env;
  const cronSecret = env?.CRON_SECRET;
  const adminKey = getAdminKey(request);
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const isAuthorized =
    (cronSecret && token && timingSafeCompare(token, cronSecret)) ||
    (env?.ADMIN_KEY && adminKey && timingSafeCompare(adminKey, env.ADMIN_KEY));

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('Database not available');
  }

  const url = new URL(request.url);
  const preview = url.searchParams.get('preview') === 'true';
  const sendTo = url.searchParams.get('sendTo');

  // Calculate week boundaries
  const now = new Date();
  const weekEnd = now.toISOString().split('T')[0];
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch digest data
  const [topReleases, topMixes, djSupportHighlights] = await Promise.all([
    getTopReleases(db, since),
    getTopMixes(db, since),
    getDjSupportHighlights(db, since),
  ]);

  // Skip if nothing happened this week
  if (topReleases.length === 0 && topMixes.length === 0 && djSupportHighlights.length === 0) {
    return successResponse({ message: 'No activity this week — skipping digest', sent: 0 });
  }

  const digestData: WeeklyDigestData = {
    topReleases,
    topMixes,
    djSupportHighlights,
    weekStart,
    weekEnd,
  };

  const html = buildWeeklyDigestHtml(digestData);

  // Preview mode — return HTML for browser rendering
  if (preview) {
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // Test send — send to a single address
  if (sendTo) {
    const result = await sendResendEmail({
      apiKey: env.RESEND_API_KEY || '',
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: sendTo,
      subject: `This Week on FreshWax (${weekStart} – ${weekEnd})`,
      html,
      template: 'weekly-digest',
      db,
    });

    return successResponse({
      testSend: true,
      to: sendTo,
      success: result.success,
      error: result.error || null,
    });
  }

  // Production send — acquire lock and send to all subscribers
  const locked = await acquireCronLock(db, 'weekly-digest');
  if (!locked) {
    return ApiErrors.conflict('Digest already sending');
  }

  const start = Date.now();

  try {
    const subscribers = await getDigestSubscribers();
    if (subscribers.length === 0) {
      return successResponse({ message: 'No subscribers found', sent: 0 });
    }

    let sent = 0;
    let failed = 0;

    // Send in batches to avoid rate limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
      const batch = subscribers.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(sub =>
          sendResendEmail({
            apiKey: env.RESEND_API_KEY || '',
            from: 'Fresh Wax <noreply@freshwax.co.uk>',
            to: sub.email,
            subject: `This Week on FreshWax (${weekStart} – ${weekEnd})`,
            html,
            template: 'weekly-digest',
            db,
          })
        )
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          sent++;
        } else {
          failed++;
        }
      }
    }

    const duration = Date.now() - start;
    log.info(`Weekly digest sent: ${sent} success, ${failed} failed, ${duration}ms`);

    return successResponse({
      sent,
      failed,
      totalSubscribers: subscribers.length,
      duration: `${duration}ms`,
    });
  } catch (error: unknown) {
    log.error('Digest error:', error instanceof Error ? error.message : error);
    return ApiErrors.serverError('Failed to send digest');
  } finally {
    await releaseCronLock(db, 'weekly-digest');
  }
};

export const GET: APIRoute = async (context) => POST(context);
