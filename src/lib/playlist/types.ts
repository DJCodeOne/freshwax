// src/lib/playlist/types.ts
// Shared context types for playlist sub-modules

import type { GlobalPlaylistItem, GlobalPlaylist } from '../types';
import type { EmbedPlayerManager } from '../embed-player';
import type { PlaylistHistoryEntry } from '../playlist-manager/types';

/**
 * Minimal interface for the playlist context passed to sub-module helpers.
 * Mirrors the relevant mutable state from PlaylistManager.
 */
export interface PlaylistContext {
  containerId: string;
  userId: string | null;
  userName: string | null;
  isAuthenticated: boolean;
  playlist: GlobalPlaylist;
  player: EmbedPlayerManager | null;
  playerPromise: Promise<EmbedPlayerManager> | null;
  trackTimer: number | null;
  recentlyPlayed: Map<string, number>;
  globalRecentlyPlayed: Record<string, unknown>[];
  countdownInterval: number | null;
  countdownTrackId: string | null;
  isFetchingDuration: boolean;
  consecutiveErrors: number;
  lastPlayedUrl: string | null;
  isPlayingLocked: boolean;
  pendingPlayRequest: boolean;
  isPausedLocally: boolean;
  playbackStartedTime: number;
  playHistory: PlaylistHistoryEntry[];
  personalPlaylist: import('../playlist-manager/types').PersonalPlaylistItem[];
  isSubscribed: boolean;
  pusherChannel: { bind: (event: string, callback: (...args: unknown[]) => void) => void; unbind_all: () => void } | null;
  wasPausedForStream: boolean;
  getAuthToken?: () => Promise<string | null>;
}
