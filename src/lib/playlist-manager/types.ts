// src/lib/playlist-manager/types.ts
// Constants and interfaces for the playlist manager

// localStorage keys
export const PLAYLIST_HISTORY_KEY = 'freshwax_playlist_history';
export const RECENTLY_PLAYED_KEY = 'freshwax_recently_played';
export const PERSONAL_PLAYLIST_KEY = 'freshwax_personal_playlist';

// Limits
export const MAX_HISTORY_SIZE = 100;
export const MAX_PERSONAL_PLAYLIST_SIZE = 500; // Increased from 50
export const TRACK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between same tracks
export const MAX_TRACK_DURATION_MS = 10 * 60 * 1000; // 10 minutes max per track
export const MAX_TRACK_DURATION_SECONDS = 10 * 60; // 10 minutes in seconds for validation

// Local playlist server (H: drive MP3s via Cloudflare tunnel)
export const LOCAL_PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';

// Fallback thumbnail for audio files without thumbnails
export const AUDIO_THUMBNAIL_FALLBACK = '/place-holder.webp';

// Server history item from /api/playlist/history/ response
export interface ServerHistoryItem {
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
}

// Server file item from /api/playlist/server-list/ response
export interface ServerFileItem {
  url: string;
  name: string;
  thumbnail?: string;
  duration?: number;
}

// History entry for offline playlist creation
export interface PlaylistHistoryEntry {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  playedAt: string;
  duration?: number;
}

// Personal playlist item (user's saved tracks)
export interface PersonalPlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedAt: string;
}
