// src/pages/api/admin/invalidate-cache.ts
// Invalidate server-side caches

import type { APIRoute } from 'astro';
import { clearCache, invalidateReleasesCache, invalidateMixesCache, getCacheStats } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const target = url.searchParams.get('target') || 'all';

  const beforeStats = getCacheStats();

  switch (target) {
    case 'releases':
      invalidateReleasesCache();
      break;
    case 'mixes':
      invalidateMixesCache();
      break;
    case 'all':
      clearCache();
      break;
    default:
      clearCache(target);
  }

  const afterStats = getCacheStats();

  return new Response(JSON.stringify({
    success: true,
    message: `Cache invalidated: ${target}`,
    before: { size: beforeStats.size, keys: beforeStats.keys.slice(0, 20) },
    after: { size: afterStats.size, keys: afterStats.keys.slice(0, 20) }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
