// src/lib/playlist-modal/dom-format.ts
// Pure formatting helpers (no DOM or state dependency).

import type { PlaylistItem } from './types';

/** Inline platform name helper (avoids importing url-parser.ts in synchronous render paths) */
export function platformName(platform: string): string {
  switch (platform) {
    case 'youtube': return 'YouTube';
    case 'vimeo': return 'Vimeo';
    case 'soundcloud': return 'SoundCloud';
    case 'direct': return 'Direct';
    default: return 'Unknown';
  }
}

/** Format duration as mm:ss or h:mm:ss */
export function formatDuration(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Format date for display */
export function formatAddedDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_e: unknown) { /* non-critical: invalid date string -- return empty for graceful display */
    return '';
  }
}

/** Format relative time from ISO timestamp */
export function formatTimeAgo(playedAt: string): string {
  if (!playedAt) return '';
  const playedTime = new Date(playedAt).getTime();
  const now = Date.now();
  const diffMs = now - playedTime;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${diffWeeks}w ago`;
}

/** Sort personal playlist items */
export function sortPersonalItems(items: PlaylistItem[], sortOrder: string): PlaylistItem[] {
  const sorted = [...items];
  switch (sortOrder) {
    case 'recent':
      return sorted.reverse();
    case 'oldest':
      return sorted;
    case 'alpha-az':
      return sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    case 'alpha-za':
      return sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    default:
      return sorted.reverse();
  }
}

/** Helper to check if title is a placeholder like "Track 1234" */
export function isPlaceholderTitle(title?: string): boolean {
  if (!title) return true;
  return /^Track\s*\d+$/i.test(title) ||
         /^YouTube Video$/i.test(title) ||
         /^SoundCloud Track$/i.test(title) ||
         /^Media Track$/i.test(title) ||
         /^Unknown Track$/i.test(title);
}

/** Extract YouTube video ID from URL */
export function getYouTubeId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}
