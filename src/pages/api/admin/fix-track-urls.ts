// src/pages/api/admin/fix-track-urls.ts
// Fix mp3Url/wavUrl for tracks in a release

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, invalidateReleasesCache } from '../../../lib/firebase-rest';
import { invalidateReleasesKVCache } from '../../../lib/kv-cache';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, successResponse } from '../../../lib/api-utils';
import { getAdminFirebaseContext } from '../../../lib/firebase/admin-context';

const fixTrackUrlsSchema = z.object({
  releaseId: z.string().min(1),
  trackFixes: z.array(z.object({
    trackIndex: z.number().int().min(0),
    mp3Url: z.string().optional(),
    wavUrl: z.string().optional(),
    previewUrl: z.string().optional(),
  })).min(1),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`fix-track-urls:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const body = await request.json();
  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const parsed = fixTrackUrlsSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.badRequest(`Invalid input: ${parsed.error.issues.map(i => i.message).join(', ')}`);
  }
  const { releaseId, trackFixes } = parsed.data;

  const fbCtx = getAdminFirebaseContext(locals);
  if (fbCtx instanceof Response) return fbCtx;
  const { projectId } = fbCtx;

  try {
    // Get current release
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return ApiErrors.notFound('Release not found');
    }

    const tracks = release.tracks || [];

    // Apply fixes
    for (const fix of trackFixes) {
      const { trackIndex, mp3Url, wavUrl, previewUrl } = fix;
      if (trackIndex >= 0 && trackIndex < tracks.length) {
        if (mp3Url !== undefined) tracks[trackIndex].mp3Url = mp3Url;
        if (wavUrl !== undefined) tracks[trackIndex].wavUrl = wavUrl;
        if (previewUrl !== undefined) tracks[trackIndex].previewUrl = previewUrl;
      }
    }

    // Convert tracks array to Firestore format
    const tracksFirestore = tracks.map((track: Record<string, unknown>) => ({
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(track).map(([k, v]) => {
            if (typeof v === 'string') return [k, { stringValue: v }];
            if (typeof v === 'number') return [k, Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }];
            if (typeof v === 'boolean') return [k, { booleanValue: v }];
            if (v === null) return [k, { nullValue: null }];
            if (Array.isArray(v)) return [k, { arrayValue: { values: [] } }]; // simplified
            if (typeof v === 'object') return [k, { mapValue: { fields: {} } }]; // simplified
            return [k, { stringValue: String(v) }];
          })
        )
      }
    }));

    // Update via REST API
    const token = await fbCtx.getToken();
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}?updateMask.fieldPaths=tracks`;

    const patchResponse = await fetchWithTimeout(docUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          tracks: {
            arrayValue: {
              values: tracksFirestore
            }
          }
        }
      })
    }, 10000);

    if (!patchResponse.ok) {
      const errorData = await patchResponse.json().catch(() => ({}));
      return ApiErrors.serverError('Failed to update');
    }

    // Sync updated release to D1 if available
    const db = env?.DB;
    if (db) {
      try {
        const freshRelease = await getDocument('releases', releaseId);
        if (freshRelease) {
          const dataJson = JSON.stringify({ ...freshRelease, id: releaseId });
          const releaseDate = freshRelease.releaseDate || freshRelease.createdAt || new Date().toISOString();
          await db.prepare(
            `UPDATE releases_v2 SET data = ?, release_date = ? WHERE id = ?`
          ).bind(dataJson, releaseDate, releaseId).run();
        }
      } catch (e: unknown) {
        // D1 sync is best-effort, don't fail the request
      }
    }

    // Clear in-memory and KV caches
    invalidateReleasesCache();
    await invalidateReleasesKVCache();

    return successResponse({ message: 'Track URLs updated and caches cleared',
      releaseId,
      updatedTracks: trackFixes.length });

  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
