// src/pages/api/admin/check-d1-release.ts
// Check what's stored in D1 for a release

import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');

  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  if (!db) {
    return new Response(JSON.stringify({ error: 'D1 database not available' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    if (releaseId) {
      // Get specific release
      const result = await db.prepare(
        'SELECT * FROM releases_v2 WHERE id = ?'
      ).bind(releaseId).first();

      if (!result) {
        return new Response(JSON.stringify({ error: 'Release not found in D1' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const data = JSON.parse(result.data);
      return new Response(JSON.stringify({
        d1Row: {
          id: result.id,
          release_date: result.release_date,
          status: result.status,
          published: result.published
        },
        releaseData: {
          releaseName: data.releaseName,
          artistName: data.artistName,
          pricePerSale: data.pricePerSale,
          trackPrice: data.trackPrice,
          pricing: data.pricing,
          catalogNumber: data.catalogNumber,
          labelCode: data.labelCode
        }
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      // List all releases
      const { results } = await db.prepare(
        'SELECT id, release_date, status, published FROM releases_v2 ORDER BY release_date DESC'
      ).all();

      return new Response(JSON.stringify({
        count: results.length,
        releases: results
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
