// src/lib/playlist/actions.ts
// Playlist action handlers for the PUT endpoint (next, play, pause, toggle, trackEnded, react, startAutoPlay)

import { addToRecentlyPlayed, pickRandomFromServerHistory, broadcastEmojiReaction } from './helpers';

export interface PlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedBy?: string;
  addedByName?: string;
  addedAt: string;
  playedAt?: string;
}

export interface GlobalPlaylist {
  queue: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  lastUpdated: string;
  trackStartedAt?: string | null;
  reactionCount?: number;
}

export interface ActionResult {
  playlist: GlobalPlaylist;
  /** If set, return early with this data (e.g. alreadyHandled) */
  earlyReturn?: { alreadyHandled: true; playlist: GlobalPlaylist };
}

/**
 * Process a playlist action (next, play, pause, toggle, trackEnded, react, startAutoPlay).
 * Returns the updated playlist and optionally an early-return signal.
 */
export async function processPlaylistAction(
  action: string,
  playlist: GlobalPlaylist,
  body: Record<string, unknown>,
  env: Record<string, unknown> | undefined
): Promise<ActionResult> {
  const now = new Date().toISOString();

  switch (action) {
    case 'next':
      // Skip current track - remove it and play next user track or autoplay
      if (playlist.queue.length > 0) {
        playlist.queue.shift();
      }

      if (playlist.queue.length > 0) {
        playlist.isPlaying = true;
        playlist.trackStartedAt = now;
        playlist.currentIndex = 0;
      } else {
        const nextRandomTrack = await pickRandomFromServerHistory(env);
        if (nextRandomTrack) {
          playlist.queue.push(nextRandomTrack);
          playlist.isPlaying = true;
          playlist.trackStartedAt = now;
          playlist.currentIndex = 0;
        } else {
          playlist.isPlaying = false;
          playlist.trackStartedAt = null;
        }
      }
      break;

    case 'play':
      playlist.isPlaying = true;
      playlist.trackStartedAt = now;
      break;

    case 'pause':
      playlist.isPlaying = false;
      playlist.trackStartedAt = null;
      break;

    case 'toggle':
      playlist.isPlaying = !playlist.isPlaying;
      playlist.trackStartedAt = playlist.isPlaying ? now : null;
      break;

    case 'trackEnded': {
      const { trackId, finishedTrackTitle } = body as { trackId?: string; finishedTrackTitle?: string };
      const currentTrack = playlist.queue[0];

      // RACE PROTECTION 1: If trackId provided and doesn't match current track, already handled
      if (trackId && currentTrack && currentTrack.id !== trackId) {
        return {
          playlist,
          earlyReturn: { alreadyHandled: true, playlist }
        };
      }

      // RACE PROTECTION 2: If a new track was started within last 5 seconds, don't pick another
      const trackJustStarted = playlist.trackStartedAt &&
        (Date.now() - new Date(playlist.trackStartedAt).getTime()) < 5000;
      if (trackJustStarted && playlist.queue.length > 0) {
        return {
          playlist,
          earlyReturn: { alreadyHandled: true, playlist }
        };
      }

      // Save the finished track to recently played before removing
      if (currentTrack) {
        const trackTitle = finishedTrackTitle || currentTrack.title;
        await addToRecentlyPlayed({
          ...currentTrack,
          title: trackTitle,
          playedAt: now
        });
      }

      // Remove only the finished track (first in queue)
      if (playlist.queue.length > 0) {
        playlist.queue.shift();
      }

      // If queue still has items (user-added tracks), play them
      if (playlist.queue.length > 0) {
        playlist.isPlaying = true;
        playlist.trackStartedAt = now;
      } else {
        // Queue is empty - pick a random track for autoplay
        let randomTrack = await pickRandomFromServerHistory(env);
        // Retry once after 1s if first attempt fails (server may be slow to respond)
        if (!randomTrack) {
          await new Promise(r => setTimeout(r, 1000));
          randomTrack = await pickRandomFromServerHistory(env);
        }
        if (randomTrack) {
          playlist.queue.push(randomTrack);
          playlist.isPlaying = true;
          playlist.trackStartedAt = now;
        } else {
          // Mark as idle but NOT permanently stopped — client will retry
          playlist.isPlaying = false;
          playlist.trackStartedAt = null;
        }
      }
      playlist.currentIndex = 0;
      playlist.reactionCount = 0;
      break;
    }

    case 'react': {
      playlist.reactionCount = (playlist.reactionCount || 0) + 1;
      const { emoji, sessionId } = body as { emoji?: string; sessionId?: string };
      if (emoji) {
        await broadcastEmojiReaction(emoji, sessionId, env);
      }
      break;
    }

    case 'startAutoPlay': {
      // RACE PROTECTION: If a track was started within last 10 seconds, don't pick new one
      const recentlyStarted = playlist.trackStartedAt &&
        (Date.now() - new Date(playlist.trackStartedAt).getTime()) < 10000;

      if (playlist.queue.length === 0 && !recentlyStarted) {
        const autoTrack = await pickRandomFromServerHistory(env);
        if (autoTrack) {
          playlist.queue.push(autoTrack);
          playlist.isPlaying = true;
          playlist.trackStartedAt = now;
          playlist.currentIndex = 0;
          playlist.reactionCount = 0;
        }
      } else if (playlist.queue.length > 0) {
        playlist.isPlaying = true;
        if (!playlist.trackStartedAt) {
          playlist.trackStartedAt = now;
        }
      }
      // else: recently started - race protection, don't change anything
      break;
    }
  }

  playlist.lastUpdated = now;
  return { playlist };
}
