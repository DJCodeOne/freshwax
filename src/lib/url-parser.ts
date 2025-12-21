// src/lib/url-parser.ts
// Parse and validate media URLs for playlist feature

export type MediaPlatform = 'youtube' | 'vimeo' | 'soundcloud' | 'direct';

export interface ParsedUrl {
  platform: MediaPlatform;
  embedId?: string;
  url: string;
  isValid: boolean;
  error?: string;
}

// YouTube: youtube.com/watch?v=xxx or youtu.be/xxx
const YOUTUBE_REGEX = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;

// Vimeo: vimeo.com/123456 or vimeo.com/channels/xxx/123456
const VIMEO_REGEX = /vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/([^\/]*)\/videos\/|video\/)?(\d+)/;

// SoundCloud: soundcloud.com/artist/track
const SOUNDCLOUD_REGEX = /soundcloud\.com\/([a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+)/;

// Direct: .mp4, .webm, .ogg, .m3u8, .mpd
const DIRECT_REGEX = /\.(mp4|webm|ogg|m3u8|mpd)(\?.*)?$/i;

/**
 * Parse a media URL and detect the platform
 */
export function parseMediaUrl(url: string): ParsedUrl {
  if (!url || typeof url !== 'string') {
    return {
      platform: 'direct',
      url: '',
      isValid: false,
      error: 'Invalid URL'
    };
  }

  const trimmedUrl = url.trim();

  // Try YouTube
  const youtubeMatch = trimmedUrl.match(YOUTUBE_REGEX);
  if (youtubeMatch && youtubeMatch[1]) {
    return {
      platform: 'youtube',
      embedId: youtubeMatch[1],
      url: trimmedUrl,
      isValid: true
    };
  }

  // Try Vimeo
  const vimeoMatch = trimmedUrl.match(VIMEO_REGEX);
  if (vimeoMatch && vimeoMatch[2]) {
    return {
      platform: 'vimeo',
      embedId: vimeoMatch[2],
      url: trimmedUrl,
      isValid: true
    };
  }

  // Try SoundCloud
  const soundcloudMatch = trimmedUrl.match(SOUNDCLOUD_REGEX);
  if (soundcloudMatch && soundcloudMatch[1]) {
    return {
      platform: 'soundcloud',
      embedId: soundcloudMatch[1],
      url: trimmedUrl,
      isValid: true
    };
  }

  // Try Direct video URL
  const directMatch = trimmedUrl.match(DIRECT_REGEX);
  if (directMatch) {
    return {
      platform: 'direct',
      url: trimmedUrl,
      isValid: true
    };
  }

  // Check if it's a valid URL at all
  try {
    new URL(trimmedUrl);
    return {
      platform: 'direct',
      url: trimmedUrl,
      isValid: false,
      error: 'Unsupported media format. Please use YouTube, Vimeo, SoundCloud, or direct video links (.mp4, .webm, .m3u8)'
    };
  } catch {
    return {
      platform: 'direct',
      url: trimmedUrl,
      isValid: false,
      error: 'Invalid URL format'
    };
  }
}

/**
 * Validate if a URL is supported
 */
export function validateUrl(url: string): boolean {
  const parsed = parseMediaUrl(url);
  return parsed.isValid;
}

/**
 * Get embed URL for a parsed media item
 */
export function getEmbedUrl(platform: MediaPlatform, embedId: string, url: string): string {
  switch (platform) {
    case 'youtube':
      return `https://www.youtube.com/embed/${embedId}?autoplay=1&enablejsapi=1`;

    case 'vimeo':
      return `https://player.vimeo.com/video/${embedId}?autoplay=1`;

    case 'soundcloud':
      return `https://w.soundcloud.com/player/?url=https://soundcloud.com/${embedId}&auto_play=true`;

    case 'direct':
      return url;

    default:
      return url;
  }
}

/**
 * Get platform display name
 */
export function getPlatformName(platform: MediaPlatform): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube';
    case 'vimeo':
      return 'Vimeo';
    case 'soundcloud':
      return 'SoundCloud';
    case 'direct':
      return 'Direct';
    default:
      return 'Unknown';
  }
}

/**
 * Sanitize URL to prevent XSS
 */
export function sanitizeUrl(url: string): string {
  // Remove any javascript: or data: protocols
  const trimmed = url.trim();
  if (trimmed.toLowerCase().startsWith('javascript:') ||
      trimmed.toLowerCase().startsWith('data:')) {
    return '';
  }
  return trimmed;
}
