// src/lib/playlist/playback.ts
// Audio playback control, track switching, sync, timers, error handling

import type { GlobalPlaylistItem, GlobalPlaylist } from '../types';
import type { EmbedPlayerManager } from '../embed-player';
import type { PlaylistContext } from './types';
import { createClientLogger } from '../client-logger';
import { TIMEOUTS } from '../timeouts';
import { MAX_CONSECUTIVE_ERRORS } from '../constants/limits';
import {
  MAX_TRACK_DURATION_MS,
  MAX_TRACK_DURATION_SECONDS,
} from '../playlist-manager/types';
import { isPlaceholderTitle } from '../playlist-manager/metadata';
import {
  saveRecentlyPlayedToStorage,
} from '../playlist-manager/history';
import {
  enableEmojis,
  disableEmojis,
  stopPlaylistMeters,
  startCountdown,
  startElapsedTimer,
  updateNowPlayingDisplay,
  showVideoPlayer,
  hidePlaylistLoadingOverlay,
  showOfflineOverlay,
} from '../playlist-manager/ui';

const log = createClientLogger('PlaylistPlayback');

// ============================================
// RECENTLY PLAYED
// ============================================

export function markAsPlayed(ctx: PlaylistContext, url: string): void {
  ctx.lastPlayedUrl = url;
  ctx.recentlyPlayed.set(url, Date.now());
  saveRecentlyPlayedToStorage(ctx.recentlyPlayed);
}

// ============================================
// TRACK TIMER
// ============================================

export function startTrackTimer(ctx: PlaylistContext, onTrackEnded: () => void): void {
  clearTrackTimer(ctx);
  ctx.trackTimer = window.setTimeout(() => {
    onTrackEnded();
  }, MAX_TRACK_DURATION_MS);
}

export function clearTrackTimer(ctx: PlaylistContext): void {
  if (ctx.trackTimer) {
    clearTimeout(ctx.trackTimer);
    ctx.trackTimer = null;
  }
}

// ============================================
// SYNC POSITION
// ============================================

export function calculateSyncPosition(ctx: PlaylistContext): number {
  if (!ctx.playlist.trackStartedAt) {
    return 0;
  }

  const startedAt = new Date(ctx.playlist.trackStartedAt).getTime();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - startedAt) / 1000);

  // Cap at 10 minutes (max track duration)
  const maxSeconds = MAX_TRACK_DURATION_MS / 1000;
  return Math.min(Math.max(0, elapsedSeconds), maxSeconds);
}

// ============================================
// ENSURE PLAYER (lazy-load)
// ============================================

export async function ensurePlayer(ctx: PlaylistContext): Promise<EmbedPlayerManager> {
  if (ctx.player) return ctx.player;

  // Prevent duplicate loading (multiple callers awaiting simultaneously)
  if (ctx.playerPromise) return ctx.playerPromise;

  ctx.playerPromise = (async () => {
    const { EmbedPlayerManager: PlayerClass } = await import('../embed-player');
    // The caller must supply callbacks via a separate setup step.
    // This function is called by the PlaylistManager class which wires
    // onEnded / onError / onReady / onStateChange / onTitleUpdate callbacks.
    // We return a bare instance here -- the class constructor handles wiring.
    // NOTE: this won't be reached because PlaylistManager.ensurePlayer() is used directly.
    throw new Error('ensurePlayer() must be called from PlaylistManager context');
  })();

  return ctx.playerPromise;
}

// ============================================
// CONTROL ACTIONS
// ============================================

export async function sendControlAction(
  ctx: PlaylistContext,
  action: string,
  playCurrent: () => Promise<void>,
  renderUI: () => void,
): Promise<void> {
  try {
    const controlController = new AbortController();
    const controlTimeoutId = setTimeout(() => controlController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/global/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        userId: ctx.userId
      }),
      signal: controlController.signal
    });
    clearTimeout(controlTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (result.success && result.playlist) {
      ctx.playlist = result.playlist;

      if (action === 'play' || action === 'next') {
        await playCurrent();
      } else if (action === 'pause') {
        if (ctx.player) await ctx.player.pause();
        disableEmojis();
      }

      renderUI();
    }
  } catch (error: unknown) {
    log.error('Control action error:', error);
  }
}

// ============================================
// AUTO-PLAY
// ============================================

export async function startAutoPlay(
  ctx: PlaylistContext,
  playCurrent: () => Promise<void>,
  renderUI: () => void,
): Promise<boolean> {
  // Don't start if live stream is active
  if ((window as any).isLiveStreamActive) {
    return false;
  }

  // Don't start if already playing or queue has items
  if (ctx.playlist.isPlaying || ctx.playlist.queue.length > 0) {
    return false;
  }

  // Check if container exists
  const container = document.getElementById(ctx.containerId);
  if (!container) {
    log.warn('Auto-play skipped - player container not found');
    return false;
  }

  // Ask SERVER to pick a track - ensures all clients get the same track
  try {
    const autoPlayController = new AbortController();
    const autoPlayTimeoutId = setTimeout(() => autoPlayController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/global/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'startAutoPlay'
      }),
      signal: autoPlayController.signal
    });
    clearTimeout(autoPlayTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (result.success && result.playlist) {
      ctx.playlist = result.playlist;

      if (ctx.playlist.queue.length > 0 && ctx.playlist.isPlaying) {
        await playCurrent();
        renderUI();
        return true;
      }
    }

    return false;
  } catch (error: unknown) {
    log.error('Error requesting auto-play from server:', error);
    return false;
  }
}

// ============================================
// TRACK ENDED
// ============================================

export async function handleTrackEnded(
  ctx: PlaylistContext,
  playCurrent: () => Promise<void>,
  renderUI: () => void,
): Promise<void> {
  // Clear all timers first
  clearTrackTimer(ctx);
  stopCountdown(ctx);

  // Capture the track ID before delay to detect if Pusher updates during wait
  const trackIdBeforeDelay = ctx.playlist.queue[ctx.playlist.currentIndex]?.id;

  // RACE PREVENTION: Add small random delay (0-300ms) to stagger requests from multiple clients
  const delay = Math.floor(Math.random() * TIMEOUTS.DEBOUNCE);
  await new Promise(resolve => setTimeout(resolve, delay));

  // Check if Pusher already updated us with a new track during the delay
  const finishedItem = ctx.playlist.queue[ctx.playlist.currentIndex];
  if (!finishedItem) {
    return;
  }

  // If the track changed during the delay, Pusher already synced us
  if (finishedItem.id !== trackIdBeforeDelay) {
    return;
  }

  // Tell the SERVER to handle track end
  try {
    const endedController = new AbortController();
    const endedTimeoutId = setTimeout(() => endedController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/global/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'trackEnded',
        trackId: finishedItem.id,
        finishedTrackTitle: finishedItem.title
      }),
      signal: endedController.signal
    });
    clearTimeout(endedTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();
    if (result.success && result.playlist) {
      ctx.playlist = result.playlist;

      if (ctx.playlist.queue.length > 0 && ctx.playlist.isPlaying) {
        await playCurrent();
      } else {
        if (ctx.player) await ctx.player.destroy();
        disableEmojis();
        updateNowPlayingDisplay(null);
        showOfflineOverlay();
      }
    }
  } catch (error: unknown) {
    log.error('Error calling trackEnded:', error);
    ctx.playlist.isPlaying = false;
    if (ctx.player) await ctx.player.destroy();
    disableEmojis();
    updateNowPlayingDisplay(null);
    showOfflineOverlay();
  }

  renderUI();
}

// ============================================
// PLAYBACK ERROR
// ============================================

export async function handlePlaybackError(
  ctx: PlaylistContext,
  error: string,
  handleTrackEndedFn: () => Promise<void>,
  renderUI: () => void,
): Promise<void> {
  log.error('Playback error:', error);

  // Check if container exists
  const container = document.getElementById(ctx.containerId);
  if (!container) {
    log.warn('Container not found - player may not be on this page. Stopping playback attempts.');
    ctx.consecutiveErrors = 0;
    return;
  }

  // Parse structured error info
  let errorInfo: { type?: string; code?: number; message?: string } = {};
  try {
    errorInfo = JSON.parse(error);
  } catch (_e: unknown) {
    /* intentional: legacy error format is a plain string, not JSON */
    errorInfo = { type: 'error', message: error };
  }

  const currentItem = ctx.playlist.queue[ctx.playlist.currentIndex];

  // Handle blocked/unavailable videos specially
  if (errorInfo.type === 'blocked' && currentItem) {
    await markVideoAsBlocked(currentItem.url, currentItem.embedId);
    clearTrackTimer(ctx);
    stopCountdown(ctx);
    await handleTrackEndedFn();
    return;
  }

  // Regular error handling
  ctx.consecutiveErrors++;

  if (ctx.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    log.warn('Too many consecutive errors, stopping playback');
    ctx.consecutiveErrors = 0;
    ctx.playlist.isPlaying = false;
    renderUI();
    return;
  }

  await handleTrackEndedFn();
}

export async function markVideoAsBlocked(url: string, embedId?: string): Promise<void> {
  try {
    const blockedController = new AbortController();
    const blockedTimeoutId = setTimeout(() => blockedController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/history/', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        embedId,
        reason: 'blocked'
      }),
      signal: blockedController.signal
    });
    clearTimeout(blockedTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();
    if (!result.success) {
      log.warn('Failed to remove blocked video from history:', result.error);
    }
  } catch (error: unknown) {
    log.error('Error marking video as blocked:', error);
  }
}

// ============================================
// PLAYER EVENT HANDLERS
// ============================================

export function handlePlayerReady(ctx: PlaylistContext): void {
  ctx.consecutiveErrors = 0;
}

export function handleStateChange(
  ctx: PlaylistContext,
  state: string,
  renderUI: () => void,
): void {
  if (state === 'playing') {
    ctx.playbackStartedTime = Date.now();
    ctx.playlist.isPlaying = true;
    hidePlaylistLoadingOverlay();
    renderUI();
    window.dispatchEvent(new CustomEvent('playlistStateChange', {
      detail: { state: 'playing', isPlaying: true }
    }));
  } else if (state === 'paused') {
    ctx.playlist.isPlaying = false;
    renderUI();
    window.dispatchEvent(new CustomEvent('playlistStateChange', {
      detail: { state: 'paused', isPlaying: false }
    }));
  }
}

export function handleTitleUpdate(
  ctx: PlaylistContext,
  title: string,
  renderUI: () => void,
): void {
  const currentItem = ctx.playlist.queue[ctx.playlist.currentIndex];
  if (currentItem && isPlaceholderTitle(currentItem.title)) {
    currentItem.title = title;
    renderUI();
  }
}

// ============================================
// DURATION DISPLAY
// ============================================

export async function updateDurationDisplay(
  ctx: PlaylistContext,
  ensurePlayerFn: () => Promise<EmbedPlayerManager>,
): Promise<void> {
  const currentTrack = ctx.playlist.queue[ctx.playlist.currentIndex];
  const currentTrackId = currentTrack?.id;

  if (ctx.countdownInterval && ctx.countdownTrackId === currentTrackId) {
    return;
  }

  if (ctx.isFetchingDuration && ctx.countdownTrackId === currentTrackId) {
    return;
  }

  stopCountdown(ctx);

  ctx.countdownTrackId = currentTrackId || null;

  const trackStartedAt = ctx.playlist.trackStartedAt
    ? new Date(ctx.playlist.trackStartedAt).getTime()
    : null;

  if (trackStartedAt && (currentTrack as GlobalPlaylistItem & { duration?: number })?.duration) {
    ctx.countdownInterval = startCountdown(
      (currentTrack as GlobalPlaylistItem & { duration?: number }).duration!,
      trackStartedAt
    );
  }

  ctx.isFetchingDuration = true;
  let duration = 0;
  try {
    const player = await ensurePlayerFn();
    duration = await player.waitForMetadata(10000);

    if (duration <= 0) {
      await new Promise(resolve => setTimeout(resolve, TIMEOUTS.ANIMATION));
      duration = await player.getDuration();
    }

    if (duration <= 0 && (currentTrack as GlobalPlaylistItem & { duration?: number })?.duration) {
      duration = (currentTrack as GlobalPlaylistItem & { duration?: number }).duration!;
    }
  } catch (error: unknown) {
    log.warn('Error getting duration:', error);
  }

  ctx.isFetchingDuration = false;

  if (duration > 0) {
    stopCountdown(ctx);
    ctx.countdownTrackId = currentTrackId || null;
    ctx.countdownInterval = startCountdown(duration, trackStartedAt);
  } else if (!ctx.countdownInterval) {
    ctx.countdownInterval = startElapsedTimer(ctx.playlist.trackStartedAt);
  }
}

export function stopCountdown(ctx: PlaylistContext): void {
  if (ctx.countdownInterval) {
    clearInterval(ctx.countdownInterval);
    ctx.countdownInterval = null;
  }
  ctx.countdownTrackId = null;
}

// ============================================
// CLEAR QUEUE
// ============================================

export async function clearQueue(ctx: PlaylistContext, renderUI: () => void): Promise<void> {
  ctx.playlist.queue = [];
  ctx.playlist.currentIndex = 0;
  ctx.playlist.isPlaying = false;

  if (ctx.player) await ctx.player.destroy();
  disableEmojis();
  updateNowPlayingDisplay(null);
  showOfflineOverlay();
  renderUI();
}

// ============================================
// PLAY CURRENT (core playback orchestration)
// ============================================

export async function playCurrent(
  ctx: PlaylistContext,
  ensurePlayerFn: () => Promise<EmbedPlayerManager>,
  logToHistoryFn: (item: GlobalPlaylistItem) => void,
  handleTrackEndedFn: () => Promise<void>,
  renderUI: () => void,
): Promise<void> {
  if ((window as any).isLiveStreamActive) return;

  const currentItem = ctx.playlist.queue[ctx.playlist.currentIndex];
  if (!currentItem) return;

  ctx.isPausedLocally = false;

  const container = document.getElementById(ctx.containerId);
  if (!container) { log.warn('Player container not found - skipping playback'); return; }

  if (ctx.isPlayingLocked) { ctx.pendingPlayRequest = true; return; }
  ctx.isPlayingLocked = true;
  ctx.pendingPlayRequest = false;

  try {
    showVideoPlayer(() => hidePlaylistLoadingOverlay());
    logToHistoryFn(currentItem);
    markAsPlayed(ctx, currentItem.url);
    startTrackTimer(ctx, handleTrackEndedFn);
    enableEmojis();
    updateNowPlayingDisplay(currentItem);

    const player = await ensurePlayerFn();

    const syncPosition = calculateSyncPosition(ctx);
    if (syncPosition > 2) player.setPendingSeek(syncPosition);

    await player.loadItem(currentItem);

    try {
      await new Promise(resolve => setTimeout(resolve, TIMEOUTS.TICK));
      const duration = await player.getDuration();
      if (duration > MAX_TRACK_DURATION_SECONDS) {
        clearTrackTimer(ctx);
        ctx.isPlayingLocked = false;
        await handleTrackEndedFn();
        return;
      }
    } catch (e: unknown) { log.warn('Could not check duration, allowing track to play:', e); }

    renderUI();
  } catch (error: unknown) {
    log.error('Error playing current:', error);
    await handleTrackEndedFn();
  } finally {
    ctx.isPlayingLocked = false;
    if (ctx.pendingPlayRequest) {
      ctx.pendingPlayRequest = false;
      setTimeout(() => playCurrent(ctx, ensurePlayerFn, logToHistoryFn, handleTrackEndedFn, renderUI), 50);
    }
  }
}

// ============================================
// RESUME
// ============================================

export async function resumePlayback(
  ctx: PlaylistContext,
  ensurePlayerFn: () => Promise<EmbedPlayerManager>,
): Promise<void> {
  if (ctx.playlist.queue.length === 0) return;
  ctx.isPausedLocally = false;

  try {
    const resumeController = new AbortController();
    const resumeTimeoutId = setTimeout(() => resumeController.abort(), TIMEOUTS.API_EXTENDED);
    const response = await fetch('/api/playlist/global/', { signal: resumeController.signal });
    clearTimeout(resumeTimeoutId);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const result = await response.json();
    if (result.success && result.playlist) ctx.playlist = result.playlist;
  } catch (error: unknown) { log.warn('Could not fetch latest state:', error); }

  const player = await ensurePlayerFn();
  await player.play();
  enableEmojis();

  const syncPosition = calculateSyncPosition(ctx);
  if (syncPosition > 2) await player.seekTo(syncPosition);

  updateDurationDisplay(ctx, ensurePlayerFn);
}
