// Work queue for the local audio-processor agent.
//
// GET  → releases whose tracks are still raw masters (WAV/AIFF/FLAC).
// POST → the agent hands back converted MP3 URLs; we merge them into the
//        release, sync D1, and publish the release if it was only being held
//        back by its audio.
//
// This replaces the old browser→localhost:8089 call, which could never work
// from the live site (the admin pages hard-disable it off localhost) and was
// the reason releases kept going out WAV-only.
//
// SECURITY: authenticated by the X-Admin-Key header ONLY — deliberately not
// via requireAdminAuth, which also accepts the __session cookie. Because no
// cookie can authenticate this route, it is safe to exempt from CSRF (a
// cross-site POST carries cookies, never the key).

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, queryCollection, invalidateReleasesCache } from '@lib/firebase-rest';
import { initKVCache, invalidateReleasesKVCache } from '@lib/kv-cache';
import { d1UpsertRelease } from '@lib/d1-catalog';
import { verifyAdminKey } from '@lib/admin';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '@lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';
import { buildAudioQueue, mergeConvertedTracks } from '@lib/release/audio-queue';
import { assessReleaseReadiness } from '@lib/release/readiness';
import { isEstablishedPartner, releaseStatusFields } from '@lib/release/auto-approve';

const log = createLogger('[admin/audio-queue]');

export const prerender = false;

function agentAuthorised(request: Request, locals: App.Locals): boolean {
  const key = request.headers.get('X-Admin-Key') || '';
  return verifyAdminKey(key, locals);
}

export const GET: APIRoute = async ({ request, locals }) => {
  if (!agentAuthorised(request, locals)) return ApiErrors.unauthorized('Admin key required');

  const env = locals?.runtime?.env;
  const publicDomain = env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk';

  initKVCache(env as { CACHE?: KVNamespace } | undefined);
  // skipCache so the agent never re-converts from a stale snapshot.
  const releases = await queryCollection('releases', { skipCache: true });

  const queue = buildAudioQueue(releases, publicDomain);
  const trackCount = queue.reduce((n, r) => n + r.tracks.length, 0);
  if (queue.length) {
    log.info(`${queue.length} release(s) / ${trackCount} track(s) awaiting conversion`);
  }

  return successResponse({ queue, releaseCount: queue.length, trackCount });
};

const completionSchema = z.object({
  releaseId: z.string().min(1).max(200),
  tracks: z.array(z.object({
    trackNumber: z.number().int().min(0).max(500),
    mp3Url: z.string().url().max(2000),
    previewUrl: z.string().url().max(2000).optional(),
    wavUrl: z.string().url().max(2000).optional(),
    duration: z.string().max(20).optional(),
  })).min(1).max(100),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const rate = checkRateLimit(`audio-queue:${getClientId(request)}`, RateLimiters.write);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfter!);

  if (!agentAuthorised(request, locals)) return ApiErrors.unauthorized('Admin key required');

  const parsed = completionSchema.safeParse(await parseJsonBody(request));
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request: ' + parsed.error.issues.map(i => i.message).join(', '));
  }
  const { releaseId, tracks: converted } = parsed.data;

  const release = await getDocument('releases', releaseId);
  if (!release) return ApiErrors.notFound('Release not found');

  const existing = Array.isArray(release.tracks) ? release.tracks as Record<string, unknown>[] : [];
  const { tracks, updated } = mergeConvertedTracks(existing, converted);
  if (updated === 0) {
    return ApiErrors.badRequest('No tracks matched — nothing updated');
  }

  const merged: Record<string, unknown> = { ...release, id: releaseId, tracks };

  // A release held back ONLY by its audio should now go live by itself —
  // otherwise the conversion still needs a human, which is the problem we set
  // out to remove. The same gate as the upload paths decides.
  const readiness = assessReleaseReadiness(merged);
  const wasHeld = release.status === 'pending' && release.published !== true;
  let published = false;

  if (wasHeld && readiness.ready) {
    const ownerId = String(release.submitterId || release.artistId || '');
    const established = await isEstablishedPartner(
      ownerId,
      (field, value) => queryCollection('releases', { filters: [{ field, op: '==', value }], skipCache: true }),
      releaseId
    );
    if (established) {
      Object.assign(merged, releaseStatusFields(true, new Date().toISOString()));
      published = true;
      log.info(`Release ${releaseId} auto-published after conversion`);
    } else {
      log.info(`Release ${releaseId} now complete but partner is not established — left for approval`);
    }
  } else if (wasHeld && !readiness.ready) {
    log.info(`Release ${releaseId} still incomplete after conversion: ${readiness.blocking.join(' | ')}`);
  }

  const updateData: Record<string, unknown> = { tracks, updatedAt: new Date().toISOString() };
  if (published) {
    updateData.status = 'live';
    updateData.published = true;
    updateData.approved = true;
    updateData.approvedAt = merged.approvedAt;
    updateData.autoApproved = true;
  }
  await updateDocument('releases', releaseId, updateData);

  // D1 mirror — listings read it first, so a live release must land here too.
  const db = locals?.runtime?.env?.DB;
  if (db) {
    try {
      await d1UpsertRelease(db, releaseId, merged);
    } catch (e: unknown) {
      log.error('D1 sync failed (continuing):', e instanceof Error ? e.message : String(e));
    }
  }

  initKVCache(locals?.runtime?.env as { CACHE?: KVNamespace } | undefined);
  invalidateReleasesCache();
  await invalidateReleasesKVCache();

  log.info(`Release ${releaseId}: ${updated} track(s) converted${published ? ', published' : ''}`);

  return successResponse({
    releaseId,
    tracksUpdated: updated,
    published,
    ready: readiness.ready,
    blocking: readiness.blocking,
  });
};
