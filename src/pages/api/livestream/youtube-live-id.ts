// src/pages/api/livestream/youtube-live-id.ts
// Fetches the current YouTube live video ID for the Fresh Wax channel
// and updates the livestream document with it

import type { APIRoute } from 'astro';
import { queryCollection, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Fresh Wax YouTube channel ID
const FRESHWAX_YOUTUBE_CHANNEL_ID = 'UCAMhFgnOL4RrYNersrqeUbQ';

function getYouTubeApiKey(env: any): string {
  return env?.YOUTUBE_API_KEY || import.meta.env.YOUTUBE_API_KEY || '';
}

// Helper to initialize Firebase
function initServices(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// First, resolve channel handle to channel ID
async function resolveChannelId(apiKey: string, handle: string): Promise<string | null> {
  try {
    // Use the channels endpoint with forHandle parameter
    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelUrl.searchParams.set('part', 'id');
    channelUrl.searchParams.set('forHandle', handle);
    channelUrl.searchParams.set('key', apiKey);

    const response = await fetch(channelUrl.toString());

    if (!response.ok) {
      console.error('[youtube-live-id] Failed to resolve handle:', handle);
      return null;
    }

    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const channelId = data.items[0].id;
      console.log('[youtube-live-id] Resolved handle', handle, 'to channel ID:', channelId);
      return channelId;
    }

    return null;
  } catch (error) {
    console.error('[youtube-live-id] Error resolving channel handle:', error);
    return null;
  }
}

// Fetch the currently live video ID from YouTube Data API
async function fetchYouTubeLiveVideoId(apiKey: string, channelIdOrHandle: string): Promise<string | null> {
  try {
    let channelId = channelIdOrHandle;

    // If it doesn't start with UC, it might be a handle - resolve it
    if (!channelIdOrHandle.startsWith('UC')) {
      const resolved = await resolveChannelId(apiKey, channelIdOrHandle);
      if (!resolved) {
        console.error('[youtube-live-id] Could not resolve channel:', channelIdOrHandle);
        return null;
      }
      channelId = resolved;
    }

    // Search for live videos on the channel
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('channelId', channelId);
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('eventType', 'live');
    searchUrl.searchParams.set('maxResults', '1');
    searchUrl.searchParams.set('key', apiKey);

    const response = await fetch(searchUrl.toString());

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[youtube-live-id] YouTube API error:', response.status, errorText);
      return null;
    }

    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const videoId = data.items[0].id?.videoId;
      console.log('[youtube-live-id] Found live video:', videoId);
      return videoId;
    }

    console.log('[youtube-live-id] No live videos found for channel');
    return null;
  } catch (error) {
    console.error('[youtube-live-id] Error fetching YouTube live ID:', error);
    return null;
  }
}

// POST - Called when a stream starts to fetch and store YouTube live ID
export const POST: APIRoute = async ({ request, locals }) => {
  initServices(locals);
  const env = (locals as any).runtime?.env;

  try {
    const body = await request.json();
    const { streamKey, channelId } = body;

    // Use provided channel ID or default to Fresh Wax
    const youtubeChannelId = channelId ||
      env?.YOUTUBE_CHANNEL_ID ||
      import.meta.env.YOUTUBE_CHANNEL_ID ||
      FRESHWAX_YOUTUBE_CHANNEL_ID;

    const apiKey = getYouTubeApiKey(env);

    if (!apiKey) {
      console.warn('[youtube-live-id] No YouTube API key configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'YouTube API key not configured',
        hint: 'Add YOUTUBE_API_KEY to your environment variables'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Fetch the live video ID from YouTube
    const youtubeLiveId = await fetchYouTubeLiveVideoId(apiKey, youtubeChannelId);

    if (!youtubeLiveId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No live stream found on YouTube',
        channelId: youtubeChannelId
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // If streamKey provided, update the livestream slot
    if (streamKey) {
      // Find the active slot by stream key
      const slots = await queryCollection('livestreamSlots', {
        filters: [
          { field: 'streamKey', op: 'EQUAL', value: streamKey }
        ],
        limit: 1
      });

      if (slots.length > 0) {
        const slotId = slots[0].id;
        await updateDocument('livestreamSlots', slotId, {
          youtubeLiveId,
          youtubeIntegration: {
            videoId: youtubeLiveId,
            chatUrl: `https://www.youtube.com/live_chat?v=${youtubeLiveId}&embed_domain=freshwax.co.uk`,
            watchUrl: `https://www.youtube.com/watch?v=${youtubeLiveId}`,
            updatedAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        });
        console.log('[youtube-live-id] Updated slot', slotId, 'with YouTube video ID:', youtubeLiveId);
      }

      // Also update livestreams collection
      const livestreams = await queryCollection('livestreams', {
        filters: [
          { field: 'streamKey', op: 'EQUAL', value: streamKey },
          { field: 'isLive', op: 'EQUAL', value: true }
        ],
        limit: 1
      });

      if (livestreams.length > 0) {
        await updateDocument('livestreams', livestreams[0].id, {
          youtubeLiveId,
          updatedAt: new Date().toISOString()
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      youtubeLiveId,
      chatUrl: `https://www.youtube.com/live_chat?v=${youtubeLiveId}&embed_domain=freshwax.co.uk`,
      watchUrl: `https://www.youtube.com/watch?v=${youtubeLiveId}`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[youtube-live-id] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// GET - Check current YouTube live status
export const GET: APIRoute = async ({ locals }) => {
  initServices(locals);
  const env = (locals as any).runtime?.env;

  const apiKey = getYouTubeApiKey(env);
  const youtubeChannelId = env?.YOUTUBE_CHANNEL_ID ||
    import.meta.env.YOUTUBE_CHANNEL_ID ||
    FRESHWAX_YOUTUBE_CHANNEL_ID;

  if (!apiKey) {
    return new Response(JSON.stringify({
      success: false,
      configured: false,
      error: 'YouTube API key not configured'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const youtubeLiveId = await fetchYouTubeLiveVideoId(apiKey, youtubeChannelId);

  return new Response(JSON.stringify({
    success: true,
    configured: true,
    channelId: youtubeChannelId,
    isLive: !!youtubeLiveId,
    youtubeLiveId,
    chatUrl: youtubeLiveId ? `https://www.youtube.com/live_chat?v=${youtubeLiveId}&embed_domain=freshwax.co.uk` : null,
    watchUrl: youtubeLiveId ? `https://www.youtube.com/watch?v=${youtubeLiveId}` : null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
