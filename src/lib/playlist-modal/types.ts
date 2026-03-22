// src/lib/playlist-modal/types.ts
// Shared type definitions for the playlist modal modules.

import type { PlaylistManager } from '../playlist-manager';

/** Lightweight interface for playlist items used in the modal UI */
export interface PlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedAt?: string;
  addedBy?: string;
  addedByName?: string;
  playedAt?: string;
  name?: string;
}

/** Sort order options for the personal playlist */
export type SortOrder = 'recent' | 'oldest' | 'alpha-az' | 'alpha-za';

/**
 * Shared mutable state for the playlist modal.
 * All sub-modules read/write through this object to replace closure variables.
 */
export interface PlaylistModalState {
  playlistManager: PlaylistManager | null;
  isStopped: boolean;
  currentUserId: string | null;
  isAuthenticated: boolean;
  hasInitializedThisPage: boolean;
  listenersAttached: boolean;
  isAddingToPlaylist: boolean;

  // Duration timer state
  durationInterval: ReturnType<typeof setInterval> | null;
  currentTrackStartTime: number | null;
  currentTrackDuration: number | null;
  lastTrackId: string | null;

  // Personal playlist pagination state
  currentPlaylistPage: number;
  cachedPersonalItems: PlaylistItem[];
  cachedUserTracksInQueue: number;
  currentSortOrder: SortOrder;

  // Recently played cache
  recentlyPlayedCache: PlaylistItem[] | null;
  recentlyPlayedCacheTime: number;
  recentlyPlayedTimeInterval: number | null;
}

/** Constants used across modules */
export const ITEMS_PER_PAGE = 20;
export const MAX_ITEMS = 500;
export const CACHE_TTL = 30000; // 30 seconds
export const AUTH_STORAGE_KEY = 'freshwax_playlist_auth';

/** Create a fresh default state */
export function createDefaultState(): PlaylistModalState {
  return {
    playlistManager: null,
    isStopped: false,
    currentUserId: null,
    isAuthenticated: false,
    hasInitializedThisPage: false,
    listenersAttached: false,
    isAddingToPlaylist: false,

    durationInterval: null,
    currentTrackStartTime: null,
    currentTrackDuration: null,
    lastTrackId: null,

    currentPlaylistPage: 1,
    cachedPersonalItems: [],
    cachedUserTracksInQueue: 0,
    currentSortOrder: 'recent',

    recentlyPlayedCache: null,
    recentlyPlayedCacheTime: 0,
    recentlyPlayedTimeInterval: null,
  };
}
