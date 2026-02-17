// src/pages/api/admin/find-release.ts
// Find a release by name

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`find-release:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || '';

  if (!name) {
    return ApiErrors.badRequest('Missing name parameter');
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

  } catch (error: unknown) {
    return ApiErrors.serverError('Failed to search releases');
  }
};
