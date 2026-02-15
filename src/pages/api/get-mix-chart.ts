// src/pages/api/get-mix-chart.ts
// Get all-time DJ mix chart based on rating score

import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-mix-chart:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Get all published mixes
    const mixesData = await queryCollection('dj-mixes', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'published' }]
    });

    const mixes = mixesData.map(data => {
      // Calculate rating score (weighted average of engagement metrics)
      const plays = data.plays || data.playCount || 0;
      const likes = data.likes || data.likeCount || 0;
      const downloads = data.downloads || data.downloadCount || 0;
      const comments = data.comments || data.commentCount || 0;

      // Score formula: plays * 0.3 + likes * 2 + downloads * 1.5 + comments * 3
      // Capped at 1000 for display purposes
      const score = Math.min(1000, Math.round(plays * 0.3 + likes * 2 + downloads * 1.5 + comments * 3));

      return {
        id: data.id,
        title: data.title,
        dj_name: data.dj_name || data.djName,
        artwork_url: data.artwork_url || data.artworkUrl || data.imageUrl,
        thumbUrl: data.thumbUrl || null,
        plays,
        likes,
        downloads,
        comments,
        score
      };
    });

    // Sort by score descending
    mixes.sort((a, b) => b.score - a.score);

    // Add chart positions
    const chart = mixes.map((mix, index) => ({
      ...mix,
      position: index + 1
    }));

    return new Response(JSON.stringify({
      success: true,
      chart: chart.slice(0, 50), // Return top 50
      total: chart.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // 5 min cache
      }
    });

  } catch (error: unknown) {
    console.error('[get-mix-chart] Error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get chart'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
