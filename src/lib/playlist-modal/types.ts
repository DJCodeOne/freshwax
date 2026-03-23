// src/lib/playlist-modal/types.ts
// Shared type definitions for playlist modal modules.

import type { PlaylistManager } from '../playlist-manager';
import type { createClientLogger } from '../client-logger';

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

/** Logger type extracted from createClientLogger */
export type Logger = ReturnType<typeof createClientLogger>;

/** Mutable shared state for the playlist modal — passed between modules */
export interface ModalState {
  log: Logger;
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
  currentSortOrder: 'recent' | 'oldest' | 'alpha-az' | 'alpha-za';

  // Recently played cache
  recentlyPlayedCache: PlaylistItem[] | null;
  recentlyPlayedCacheTime: number;

  // Recently played time update interval
  recentlyPlayedTimeInterval: number | null;
}
