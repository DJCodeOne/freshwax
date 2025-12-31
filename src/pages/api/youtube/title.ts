// src/pages/api/youtube/title.ts
// Server-side API to fetch YouTube video title (avoids CORS issues)

import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const videoId = url.searchParams.get('videoId');

  if (!videoId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Missing videoId parameter'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Validate video ID format (11 characters, alphanumeric + dash/underscore)
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid video ID format'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Use YouTube oEmbed API (no API key required)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });

    if (response.ok) {
      const data = await response.json();
      return new Response(JSON.stringify({
        success: true,
        title: data.title || null,
        author: data.author_name || null,
        thumbnail: data.thumbnail_url || null
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // If oEmbed fails, return null title
    return new Response(JSON.stringify({
      success: true,
      title: null,
      error: 'Could not fetch video info'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[youtube/title] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      title: null,
      error: 'Failed to fetch title'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
