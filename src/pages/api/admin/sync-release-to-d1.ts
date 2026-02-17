// src/pages/api/admin/sync-release-to-d1.ts
// Sync a release from Firebase to D1 database

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, invalidateReleasesCache } from '../../../lib/firebase-rest';
import { kvDelete, CACHE_CONFIG } from '../../../lib/kv-cache';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`sync-release-to-d1:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');
  const all = url.searchParams.get('all') === 'true';
  const confirm = url.searchParams.get('confirm');
  const db = env?.DB;

  if (!db) {
    return ApiErrors.serverError('D1 database not available');
  }

  try {
    let releases: any[] = [];

    if (all) {
      // Sync all live releases
      releases = await queryCollection('releases', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 100
      });
    } else if (releaseId) {
      // Sync specific release
      const release = await getDocument('releases', releaseId);
      if (release) {
        releases = [{ ...release, id: releaseId }];
      }
    } else {
      return ApiErrors.badRequest('Missing releaseId or all=true');
    }

    if (releases.length === 0) {
      return ApiErrors.notFound('No releases found');
    }

    if (confirm !== 'yes') {
      return new Response(JSON.stringify({
        message: `Would sync ${releases.length} releases to D1`,
        releases: releases.map((r: any) => ({
          id: r.id,
          releaseName: r.releaseName,
          artistName: r.artistName,
          catalogNumber: r.catalogNumber || '(none)',
          labelCode: r.labelCode || '(none)'
        })),
        usage: 'Add &confirm=yes to apply'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Sync to D1
    const results: any[] = [];
    for (const release of releases) {
      try {
        // Check if release exists in D1
        const existing = await db.prepare(
          'SELECT id FROM releases_v2 WHERE id = ?'
        ).bind(release.id).first();

        const releaseDate = release.releaseDate || release.createdAt || new Date().toISOString();
        const dataJson = JSON.stringify(release);

        if (existing) {
          // Update existing
          await db.prepare(`
            UPDATE releases_v2
            SET data = ?, release_date = ?, status = ?, published = ?
            WHERE id = ?
          `).bind(
            dataJson,
            releaseDate,
            release.status || 'live',
            release.status === 'live' ? 1 : 0,
            release.id
          ).run();
          results.push({ id: release.id, action: 'updated' });
        } else {
          // Insert new
          await db.prepare(`
            INSERT INTO releases_v2 (id, data, release_date, status, published)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            release.id,
            dataJson,
            releaseDate,
            release.status || 'live',
            release.status === 'live' ? 1 : 0
          ).run();
          results.push({ id: release.id, action: 'inserted' });
        }
      } catch (e: unknown) {
        results.push({ id: release.id, action: 'error', error: 'Sync failed' });
      }
    }

    // Clear in-memory and KV caches so fresh data is served immediately
    invalidateReleasesCache();
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => {});
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      message: `Synced ${results.length} releases to D1 and cleared caches`,
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
