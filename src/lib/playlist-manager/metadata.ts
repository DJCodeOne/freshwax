// src/lib/playlist-manager/metadata.ts
// Metadata fetching functions for playlist items (oEmbed, YouTube, SoundCloud)

import { createClientLogger } from '../client-logger';
import { TIMEOUTS } from '../timeouts';

const log = createClientLogger('PlaylistMetadata');

/**
 * Check if a title is a placeholder (e.g., "Track 1234")
 */
export function isPlaceholderTitle(title?: string): boolean {
  if (!title) return true;
  return /^Track \d+$/i.test(title);
}

/**
 * Fetch video metadata using noembed.com with YouTube/SoundCloud fallback
 */
export async function fetchMetadata(url: string): Promise<{ title?: string; thumbnail?: string; duration?: number }> {
  try {
    // Try noembed first
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);
    try {
      const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, { signal: controller.signal });
      if (response.ok) {
        const data = await response.json();
        if (data.title) {
          return {
            title: data.title,
            thumbnail: data.thumbnail_url || undefined,
            duration: data.duration || undefined
          };
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.warn('noembed timed out');
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error: unknown) {
    log.warn('noembed failed:', error);
  }

  // Fallback: Try YouTube oEmbed directly for YouTube URLs
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);
    try {
      const ytResponse = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: controller.signal });
      if (ytResponse.ok) {
        const ytData = await ytResponse.json();
        return {
          title: ytData.title || undefined,
          thumbnail: ytData.thumbnail_url || undefined,
          duration: undefined
        };
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('YouTube oEmbed timed out');
      } else {
        log.warn('YouTube oEmbed failed:', error);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Fallback: Try SoundCloud oEmbed for SoundCloud URLs
  if (url.includes('soundcloud.com')) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);
    try {
      const scResponse = await fetch(`https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: controller.signal });
      if (scResponse.ok) {
        const scData = await scResponse.json();
        return {
          title: scData.title || undefined,
          thumbnail: scData.thumbnail_url || undefined,
          duration: undefined
        };
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('SoundCloud oEmbed timed out');
      } else {
        log.warn('SoundCloud oEmbed failed:', error);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  log.warn('Could not fetch metadata for:', url);
  return {};
}

/**
 * Fetch YouTube video duration via YouTube Data API proxy
 * Returns duration in seconds, or null if unknown
 */
export async function fetchVideoDuration(url: string, platform: string, embedId?: string): Promise<number | null> {
  // For YouTube, try to get duration from a proxy endpoint
  if (platform === 'youtube' && embedId) {
    try {
      // Try our API endpoint that can check duration
      const response = await fetch(`/api/youtube/duration/?videoId=${embedId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.duration) {
          return data.duration;
        }
      }
    } catch (error: unknown) {
      log.warn('Could not fetch YouTube duration:', error);
    }
  }

  // Duration check not available for this platform
  return null;
}

/**
 * Fetch actual YouTube title via oEmbed
 */
export async function fetchYouTubeTitle(videoId: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: controller.signal });
    if (response.ok) {
      const data = await response.json();
      return data.title || null;
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      log.warn('YouTube title fetch timed out');
    } else {
      log.warn('Could not fetch YouTube title:', error);
    }
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}
