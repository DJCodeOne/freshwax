// src/pages/api/admin/sync-release-to-d1.ts
// Sync a release from Firebase to D1 database

import type { APIRoute } from 'astro';
import { initFirebaseEnv, getDocument, queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');
  const all = url.searchParams.get('all') === 'true';
  const confirm = url.searchParams.get('confirm');

  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  if (!db) {
    return new Response(JSON.stringify({ error: 'D1 database not available' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

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
      return new Response(JSON.stringify({
        error: 'Missing releaseId or all=true',
        usage: '/api/admin/sync-release-to-d1?releaseId=xxx&confirm=yes',
        altUsage: '/api/admin/sync-release-to-d1?all=true&confirm=yes'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (releases.length === 0) {
      return new Response(JSON.stringify({ error: 'No releases found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
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
      } catch (e: any) {
        results.push({ id: release.id, action: 'error', error: e.message });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Synced ${results.length} releases to D1`,
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
