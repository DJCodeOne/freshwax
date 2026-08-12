// /src/pages/api/pro/update-release-shipping.ts
// Artist self-service: set per-release vinyl shipping rates (UK / EU / Intl)
// and the pressing stock.
// The cart's price-pick order is: release-level rate → artist-account default
// → hardcoded floor. Setting any rate here overrides the artist default for
// that one release; clearing it (sending null) returns to the default.
//
// vinylStock is how many copies are sellable. It is NOT vinylRecordCount —
// that field is how many discs are in the release (single vs double LP) and
// must never be used as stock. Multi-part releases track stock per part via
// update-release-vinyl-parts, so stock edits are rejected for those to avoid
// two competing sources of truth.
//
// Authorisation is strictly scoped — release.artistId / release.userId /
// release.submittedBy must match the authenticated user. Admins still own
// arbitrary edits via /admin/releases/edit/[id].

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, verifyRequestUser, invalidateReleasesCache } from '../../../lib/firebase-rest';
import { initKVCache, invalidateReleasesKVCache } from '../../../lib/kv-cache';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('[pro/update-release-shipping]');

export const prerender = false;

// Each rate is optional. `null` clears the per-release override (falls back to
// artist-account defaults). A number ≥0 sets a fixed override. £0 is treated
// as a valid free-shipping override, not as "unset" — labels do offer free UK
// shipping on some releases.
const rateSchema = z.union([z.number().min(0).max(999), z.null()]);

// 99999 is the "unlimited / not tracked" sentinel used across the codebase.
// null clears the value back to that sentinel rather than to 0, so clearing
// the box can never accidentally take a release out of stock.
const stockSchema = z.union([z.number().int().min(0).max(99999), z.null()]);

const schema = z.object({
  releaseId: z.string().min(1),
  vinylShippingUK: rateSchema.optional(),
  vinylShippingEU: rateSchema.optional(),
  vinylShippingIntl: rateSchema.optional(),
  vinylShippingAdditional: rateSchema.optional(),
  vinylStock: stockSchema.optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`pro-update-release-shipping:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) return ApiErrors.unauthorized(authError || 'Authentication required');

  const body = await parseJsonBody(request);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request: ' + parsed.error.issues.map(i => i.message).join(', '));
  }
  const { releaseId, vinylShippingUK, vinylShippingEU, vinylShippingIntl, vinylShippingAdditional, vinylStock } = parsed.data;

  const release = await getDocument('releases', releaseId);
  if (!release) return ApiErrors.notFound('Release not found');

  // Ownership: accept any of the three ID fields. artistId is the primary one
  // (set during release creation), userId/submittedBy are legacy fallbacks for
  // older releases. Labels with multiple artists set artistId to the label
  // user, so this works for single-artist + various-artists releases alike.
  const ownerIds = [release.artistId, release.userId, release.submittedBy].filter(Boolean);
  if (!ownerIds.includes(userId)) {
    log.warn(`User ${userId} tried to update shipping on release ${releaseId} they don't own`);
    return ApiErrors.forbidden('You do not have permission to update this release');
  }

  // Only update the fields the caller actually sent — preserves any
  // unspecified region. Casting through unknown so partial updates type-check.
  const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (vinylShippingUK !== undefined) updateData.vinylShippingUK = vinylShippingUK;
  if (vinylShippingEU !== undefined) updateData.vinylShippingEU = vinylShippingEU;
  if (vinylShippingIntl !== undefined) updateData.vinylShippingIntl = vinylShippingIntl;
  if (vinylShippingAdditional !== undefined) updateData.vinylShippingAdditional = vinylShippingAdditional;

  if (vinylStock !== undefined) {
    const parts = Array.isArray(release.vinylParts) ? release.vinylParts : [];
    if (parts.length > 0) {
      return ApiErrors.badRequest('This release tracks stock per vinyl part — set it on each part instead');
    }
    updateData.vinylStock = vinylStock === null ? 99999 : vinylStock;
  }

  if (Object.keys(updateData).length === 1) {
    return ApiErrors.badRequest('No shipping rates or stock supplied');
  }

  await updateDocument('releases', releaseId, updateData);
  log.info(`Release ${releaseId} shipping updated by artist ${userId}`, updateData);

  // Sync D1 mirror so the cart fallback chain picks up the change immediately.
  // Best-effort: D1 sync failures don't roll back Firestore — the periodic sync
  // cron will catch them up eventually.
  const env = locals?.runtime?.env;
  const db = env?.DB;
  if (db) {
    try {
      const fresh = await getDocument('releases', releaseId);
      if (fresh) {
        const dataJson = JSON.stringify({ ...fresh, id: releaseId });
        const releaseDate = fresh.releaseDate || fresh.createdAt || new Date().toISOString();
        // vinyl_stock is a real column (listings and the Google Shopping feed
        // read it), so the JSON blob alone is not enough to reflect a change.
        await db.prepare(
          `UPDATE releases_v2 SET data = ?, release_date = ?, vinyl_stock = ? WHERE id = ?`
        ).bind(dataJson, releaseDate, Number(fresh.vinylStock ?? 0), releaseId).run();
      }
    } catch (e: unknown) {
      log.error('D1 sync failed (continuing)', e instanceof Error ? e.message : e);
    }
  }

  // Bust caches so the storefront sees fresh values on the next read.
  initKVCache(env as { CACHE?: KVNamespace } | undefined);
  invalidateReleasesCache();
  await invalidateReleasesKVCache();

  return successResponse({
    releaseId,
    shipping: {
      vinylShippingUK: vinylShippingUK !== undefined ? vinylShippingUK : (release.vinylShippingUK ?? null),
      vinylShippingEU: vinylShippingEU !== undefined ? vinylShippingEU : (release.vinylShippingEU ?? null),
      vinylShippingIntl: vinylShippingIntl !== undefined ? vinylShippingIntl : (release.vinylShippingIntl ?? null),
      vinylShippingAdditional: vinylShippingAdditional !== undefined ? vinylShippingAdditional : (release.vinylShippingAdditional ?? null),
    },
    vinylStock: updateData.vinylStock !== undefined ? updateData.vinylStock : (release.vinylStock ?? null),
  });
};
