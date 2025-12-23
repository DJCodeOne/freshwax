// src/pages/api/youtube/duration.ts
// Fetch YouTube video duration
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('videoId');

  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Missing videoId parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Try to get duration from YouTube's oEmbed endpoint
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const oembedResponse = await fetch(oembedUrl);

    if (oembedResponse.ok) {
      // oEmbed doesn't include duration, so we need another approach
      // Try noembed which sometimes has duration
      const noembedUrl = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`;
      const noembedResponse = await fetch(noembedUrl);

      if (noembedResponse.ok) {
        const data = await noembedResponse.json();
        if (data.duration) {
          return new Response(JSON.stringify({ duration: data.duration }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // Try YouTube Data API if we have a key
    const runtime = (locals as any).runtime;
    const apiKey = runtime?.env?.YOUTUBE_API_KEY;

    if (apiKey) {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=contentDetails&key=${apiKey}`;
      const apiResponse = await fetch(apiUrl);

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        if (data.items && data.items.length > 0) {
          const duration = data.items[0].contentDetails?.duration;
          if (duration) {
            // Convert ISO 8601 duration to seconds
            const seconds = parseISO8601Duration(duration);
            return new Response(JSON.stringify({ duration: seconds }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
      }
    }

    // Fallback: try to scrape duration from video page
    const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageResponse = await fetch(videoPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (pageResponse.ok) {
      const html = await pageResponse.text();

      // Try to find duration in the page's JSON data
      const lengthMatch = html.match(/"lengthSeconds":"(\d+)"/);
      if (lengthMatch) {
        const seconds = parseInt(lengthMatch[1], 10);
        return new Response(JSON.stringify({ duration: seconds }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Try alternative pattern
      const durationMatch = html.match(/"approxDurationMs":"(\d+)"/);
      if (durationMatch) {
        const seconds = Math.floor(parseInt(durationMatch[1], 10) / 1000);
        return new Response(JSON.stringify({ duration: seconds }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Could not get duration
    return new Response(JSON.stringify({ error: 'Could not fetch duration', duration: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[YouTube Duration API] Error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch duration' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Parse ISO 8601 duration (PT1H2M3S) to seconds
function parseISO8601Duration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}
