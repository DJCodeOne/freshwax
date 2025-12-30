// src/pages/api/youtube/duration.ts
// API endpoint to get YouTube video duration using oEmbed + fallback to player check

import type { APIRoute } from 'astro';

export const prerender = false;

// Parse ISO 8601 duration (PT#M#S format) to seconds
function parseISO8601Duration(duration: string): number | null {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}

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
    // Method 1: Try YouTube Data API if we have an API key
    const youtubeApiKey = import.meta.env.YOUTUBE_API_KEY;

    if (youtubeApiKey) {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=contentDetails&key=${youtubeApiKey}`;
      const apiResponse = await fetch(apiUrl);

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        if (data.items && data.items.length > 0) {
          const duration = data.items[0].contentDetails?.duration;
          if (duration) {
            const seconds = parseISO8601Duration(duration);
            if (seconds !== null) {
              return new Response(JSON.stringify({
                success: true,
                duration: seconds,
                source: 'youtube-api'
              }), {
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }
        }
      }
    }

    // Method 2: Try noembed.com (sometimes has duration)
    try {
      const noembedUrl = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`;
      const noembedResponse = await fetch(noembedUrl, { signal: AbortSignal.timeout(5000) });

      if (noembedResponse.ok) {
        const data = await noembedResponse.json();
        if (data.duration) {
          return new Response(JSON.stringify({
            success: true,
            duration: data.duration,
            source: 'noembed'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    } catch (e) {
      // noembed failed, continue
    }

    // Method 3: Duration not available without API key
    // Return null to indicate we couldn't get the duration
    return new Response(JSON.stringify({
      success: true,
      duration: null,
      source: 'unavailable',
      message: 'Duration check requires YouTube API key'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[youtube/duration] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch duration',
      duration: null
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
