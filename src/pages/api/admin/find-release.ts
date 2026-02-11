// src/pages/api/admin/find-release.ts
// Find a release by name

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || '';

  if (!name) {
    return new Response(JSON.stringify({
      error: 'Missing name parameter',
      usage: 'GET /api/admin/find-release?name=demo'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Get all releases and filter by name (case-insensitive)
    const releases = await queryCollection('releases', { limit: 500, cacheTime: 60000 });
    
    const searchTerm = name.toLowerCase();
    const matches = releases.filter((r: any) => {
      const releaseName = (r.releaseName || r.title || '').toLowerCase();
      const artistName = (r.artistName || '').toLowerCase();
      return releaseName.includes(searchTerm) || artistName.includes(searchTerm);
    });

    return new Response(JSON.stringify({
      count: matches.length,
      releases: matches.map((r: any) => ({
        id: r.id,
        releaseName: r.releaseName || r.title,
        artistName: r.artistName,
        submittedBy: r.submittedBy || '(not set)',
        artistId: r.artistId || '(not set)'
      }))
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to search releases'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
