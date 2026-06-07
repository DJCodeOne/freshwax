// /src/pages/api/pro/update-release-vinyl-parts.ts
// Artist self-service: edit per-part stock / price / pressed status for a
// multi-part vinyl release they own.
//
// Each part is identified by its index in the vinylParts array (1-based —
// 'part-1', 'part-2' — matching the partId the buy flow uses). The caller
// sends only the parts they want to change; absent parts are left alone.
// The trackNumbers split is NOT editable here — admins set that on initial
// processing and changing it after the fact would risk shifting paid-for
// tracks between records.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, verifyRequestUser, invalidateReleasesCache } from '../../../lib/firebase-rest';
import { initKVCache, invalidateReleasesKVCache } from '../../../lib/kv-cache';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('[pro/update-release-vinyl-parts]');

export const prerender = false;

const partUpdateSchema = z.object({
  partId: z.string().regex(/^part-\d+$/),
  stock: z.number().int().min(0).max(99999).optional(),
  price: z.number().min(0).max(999).optional(),
  pressed: z.boolean().optional(),
});

const schema = z.object({
  releaseId: z.string().min(1),
  parts: z.array(partUpdateSchema).min(1).max(10),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`pro-update-vinyl-parts:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) return ApiErrors.unauthorized(authError || 'Authentication required');

  const body = await parseJsonBody(request);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request: ' + parsed.error.issues.map(i => i.message).join(', '));
  }
  const { releaseId, parts: partUpdates } = parsed.data;

  const release = await getDocument('releases', releaseId);
  if (!release) return ApiErrors.notFound('Release not found');

  const ownerIds = [release.artistId, release.userId, release.submittedBy].filter(Boolean);
  if (!ownerIds.includes(userId)) {
    log.warn(`User ${userId} tried to update vinyl parts on release ${releaseId} they don't own`);
    return ApiErrors.forbidden('You do not have permission to update this release');
  }

  const existingParts = Array.isArray(release.vinylParts) ? release.vinylParts as Record<string, unknown>[] : [];
  if (existingParts.length === 0) {
    return ApiErrors.badRequest('This release has no vinyl parts to edit. Ask an admin to set up multi-part vinyl first.');
  }

  // Apply each update by index (partId 'part-N' → index N-1). Unknown partIds
  // are rejected outright so a stale client can't silently no-op.
  const nextParts = existingParts.map(p => ({ ...p }));
  for (const upd of partUpdates) {
    const idx = parseInt(upd.partId.slice(5), 10) - 1;
    if (idx < 0 || idx >= nextParts.length) {
      return ApiErrors.badRequest(`Unknown vinyl part: ${upd.partId} (release has ${nextParts.length} parts)`);
    }
    if (upd.stock !== undefined) nextParts[idx].stock = upd.stock;
    if (upd.price !== undefined) nextParts[idx].price = upd.price;
    if (upd.pressed !== undefined) nextParts[idx].pressed = upd.pressed;
  }

  await updateDocument('releases', releaseId, {
    vinylParts: nextParts,
    updatedAt: new Date().toISOString(),
  });
  log.info(`Release ${releaseId} vinyl parts updated by artist ${userId}`);

  // D1 sync + cache bust so the storefront sees the new stock / price next request.
  const env = locals?.runtime?.env;
  const db = env?.DB;
  if (db) {
    try {
      const fresh = await getDocument('releases', releaseId);
      if (fresh) {
        const dataJson = JSON.stringify({ ...fresh, id: releaseId });
        const releaseDate = fresh.releaseDate || fresh.createdAt || new Date().toISOString();
        await db.prepare(
          `UPDATE releases_v2 SET data = ?, release_date = ? WHERE id = ?`
        ).bind(dataJson, releaseDate, releaseId).run();
      }
    } catch (e: unknown) {
      log.error('D1 sync failed (continuing)', e instanceof Error ? e.message : e);
    }
  }
  initKVCache(env as { CACHE?: KVNamespace } | undefined);
  invalidateReleasesCache();
  await invalidateReleasesKVCache();

  return successResponse({
    releaseId,
    parts: nextParts.map(p => ({
      name: p.name ?? null,
      price: p.price ?? null,
      stock: p.stock ?? null,
      pressed: p.pressed !== false,
    })),
  });
};
