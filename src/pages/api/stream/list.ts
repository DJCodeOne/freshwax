// src/pages/api/stream/list.ts
// List recent streams for admin dashboard
import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    const status = url.searchParams.get('status'); // 'live', 'offline', 'all'

    // Build filters
    const filters: any[] = [];

    if (status && status !== 'all') {
      filters.push({ field: 'status', op: 'EQUAL', value: status });
    }

    // Query streams
    const streams = await queryCollection('livestreams', {
      filters,
      orderBy: { field: 'startedAt', direction: 'DESCENDING' },
      limit: Math.min(limit, 50),
      skipCache: true
    });

    // Format response
    const formattedStreams = streams.map(stream => ({
      id: stream.id,
      title: stream.title || 'Untitled Stream',
      djId: stream.djId,
      djName: stream.djName || 'Unknown DJ',
      genre: stream.genre || 'Drum & Bass',
      status: stream.status || (stream.isLive ? 'live' : 'offline'),
      isLive: stream.isLive || false,
      startedAt: stream.startedAt,
      endedAt: stream.endedAt,
      durationSeconds: stream.startedAt && stream.endedAt
        ? Math.floor((new Date(stream.endedAt).getTime() - new Date(stream.startedAt).getTime()) / 1000)
        : null,
      peakViewers: stream.peakViewers || 0,
      totalViews: stream.totalViews || 0,
      likeCount: stream.totalLikes || stream.likeCount || 0,
      averageRating: stream.averageRating || null,
      ratingCount: stream.ratingCount || 0,
      coverImage: stream.coverImage || null
    }));

    return new Response(JSON.stringify({
      success: true,
      streams: formattedStreams,
      count: formattedStreams.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[stream/list] Error:', error);
    return new Response(JSON.stringify({
      success: true,
      streams: [],
      error: error.message
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
