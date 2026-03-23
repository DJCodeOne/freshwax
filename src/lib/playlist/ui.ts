// src/lib/playlist/ui.ts
// DOM rendering, UI updates for playlist — wraps and re-exports playlist-manager/ui.ts

import type { GlobalPlaylistItem } from '../types';
import type { PlaylistContext } from './types';
import type { PersonalPlaylistItem } from '../playlist-manager/types';

// Re-export all functions from the existing playlist-manager/ui.ts
export {
  enableEmojis,
  disableEmojis,
  stopPlaylistMeters,
  startCountdown,
  startElapsedTimer,
  formatDuration,
  updateNowPlayingDisplay,
  showVideoPlayer,
  hidePlaylistLoadingOverlay,
  showOfflineOverlay,
} from '../playlist-manager/ui';

/**
 * Render UI by dispatching a playlistUpdate custom event.
 * This is called by the PlaylistManager class to notify all listeners.
 */
export function renderPlaylistUI(ctx: PlaylistContext): void {
  // Update reaction count display
  const reactionCount = (ctx.playlist as any).reactionCount || 0;
  const likeCountEl = document.getElementById('likeCount');
  const fsLikes = document.getElementById('fsLikes');
  if (likeCountEl) likeCountEl.textContent = String(reactionCount);
  if (fsLikes) fsLikes.textContent = String(reactionCount);

  const event = new CustomEvent('playlistUpdate', {
    detail: {
      queue: ctx.playlist.queue,
      currentIndex: ctx.playlist.currentIndex,
      isPlaying: ctx.playlist.isPlaying,
      queueSize: ctx.playlist.queue.length,
      isAuthenticated: ctx.isAuthenticated,
      userId: ctx.userId,
      trackStartedAt: ctx.playlist.trackStartedAt,
      userQueuePosition: getUserQueuePosition(ctx),
      userTracksInQueue: getUserTracksInQueue(ctx),
      isUsersTurn: isUsersTurn(ctx),
      currentDj: getCurrentDj(ctx),
      personalPlaylist: [...ctx.personalPlaylist],
      recentlyPlayed: ctx.globalRecentlyPlayed,
      reactionCount: reactionCount
    }
  });
  window.dispatchEvent(event);
}

// ============================================
// DJ WAITLIST HELPERS
// ============================================

export function getUserQueuePosition(ctx: PlaylistContext): number | null {
  if (!ctx.userId) return null;
  const index = ctx.playlist.queue.findIndex(item => item.addedBy === ctx.userId);
  return index >= 0 ? index + 1 : null;
}

export function getUserTracksInQueue(ctx: PlaylistContext): number {
  if (!ctx.userId) return 0;
  return ctx.playlist.queue.filter(item => item.addedBy === ctx.userId).length;
}

export function isUsersTurn(ctx: PlaylistContext): boolean {
  if (!ctx.userId) return false;
  const currentItem = ctx.playlist.queue[0];
  return currentItem?.addedBy === ctx.userId;
}

export function getCurrentDj(ctx: PlaylistContext): { userId: string; userName: string } | null {
  const currentItem = ctx.playlist.queue[0];
  if (!currentItem) return null;
  return {
    userId: currentItem.addedBy || '',
    userName: currentItem.addedByName || 'Anonymous'
  };
}
