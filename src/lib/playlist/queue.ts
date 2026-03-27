// src/lib/playlist/queue.ts
// Queue management: add/remove items, Pusher sync, load from server

import type { GlobalPlaylistItem, GlobalPlaylist } from '../types';
import type { PlaylistContext } from './types';
import type { PersonalPlaylistItem } from '../playlist-manager/types';
import { createClientLogger } from '../client-logger';
import { TIMEOUTS } from '../timeouts';
import {
  MAX_TRACK_DURATION_SECONDS,
} from '../playlist-manager/types';
import {
  isPlaceholderTitle,
  fetchMetadata,
  fetchVideoDuration,
} from '../playlist-manager/metadata';
import {
  wasPlayedRecently,
} from '../playlist-manager/history';
import {
  addToPersonalPlaylistItems,
  removeFromPersonalPlaylistItems,
  savePersonalPlaylistToStorage,
  savePersonalPlaylistToServer,
} from '../playlist-manager/personal-playlist';
import {
  disableEmojis,
  updateNowPlayingDisplay,
  showOfflineOverlay,
} from '../playlist-manager/ui';
import { clearTrackTimer, stopCountdown } from './playback';

const log = createClientLogger('PlaylistQueue');

// ============================================
// ADD ITEM
// ============================================

export async function addItem(
  ctx: PlaylistContext,
  url: string,
  generateId: () => string,
  getAuthToken: () => Promise<string | null>,
  logToHistory: (item: GlobalPlaylistItem) => void,
  playCurrent: () => Promise<void>,
  renderUI: () => void,
): Promise<{ success: boolean; message?: string; error?: string }> {
  if (!url || !url.trim()) {
    return { success: false, error: 'Please enter a URL' };
  }

  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: 'Please sign in to add to playlist' };
  }

  // Check if URL was played recently (within 1 hour)
  const recentCheck = wasPlayedRecently(ctx.recentlyPlayed, url.trim());
  if (recentCheck.recent) {
    return {
      success: false,
      error: `This track was played recently. Try again in ${recentCheck.minutesRemaining} minutes.`
    };
  }

  // Check if URL is already in the current queue
  const alreadyInQueue = ctx.playlist.queue.some(item => item.url === url.trim());
  if (alreadyInQueue) {
    return { success: false, error: 'This track is already in the queue' };
  }

  // DJ Waitlist: Check if user already has max tracks in queue (2 tracks per DJ)
  const userTracksInQueue = ctx.playlist.queue.filter(item => item.addedBy === ctx.userId).length;
  if (userTracksInQueue >= 2) {
    return { success: false, error: 'You already have 2 tracks in the queue. Wait for one to play or remove it first.' };
  }

  try {
    // Parse URL locally first (dynamically imported to reduce initial bundle)
    const { parseMediaUrl } = await import('../url-parser');
    const parsed = parseMediaUrl(url.trim());

    if (!parsed.isValid) {
      return { success: false, error: parsed.error || 'Invalid URL' };
    }

    // Check duration for YouTube videos before adding
    if (parsed.platform === 'youtube' && parsed.embedId) {
      const duration = await fetchVideoDuration(url.trim(), parsed.platform, parsed.embedId);
      if (duration && duration > MAX_TRACK_DURATION_SECONDS) {
        const mins = Math.floor(duration / 60);
        const secs = Math.floor(duration % 60);
        return {
          success: false,
          error: `Track is too long (${mins}:${secs.toString().padStart(2, '0')}). Maximum allowed is 10 minutes.`
        };
      }
    }

    // Fetch metadata for thumbnail/title
    const metadata = await fetchMetadata(url.trim());

    // Get thumbnail - prefer oEmbed, fallback to YouTube direct
    let thumbnail = metadata.thumbnail;
    if (!thumbnail && parsed.platform === 'youtube' && parsed.embedId) {
      thumbnail = `https://img.youtube.com/vi/${parsed.embedId}/mqdefault.jpg`;
    }

    const item = {
      id: generateId(),
      url: url.trim(),
      platform: parsed.platform,
      embedId: parsed.embedId,
      title: metadata.title,
      thumbnail,
      addedAt: new Date().toISOString()
    };

    // Send to global API
    const idToken = await getAuthToken();
    const postHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idToken) postHeaders['Authorization'] = `Bearer ${idToken}`;

    const addController = new AbortController();
    const addTimeoutId = setTimeout(() => addController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/global/', {
      method: 'POST',
      headers: postHeaders,
      body: JSON.stringify({
        item,
        userId: ctx.userId,
        userName: ctx.userName || 'Anonymous'
      }),
      signal: addController.signal
    });
    clearTimeout(addTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (!result.success) {
      return { success: false, error: result.error || 'Failed to add to queue' };
    }

    // Update local state immediately (Pusher will also send update)
    if (result.playlist) {
      ctx.playlist = result.playlist;

      // Auto-play if this is the first item
      if (ctx.playlist.queue.length === 1 && ctx.playlist.isPlaying) {
        await playCurrent();
      }
    }

    // Log to history immediately when URL is posted (for auto-play feature)
    const historyItem: GlobalPlaylistItem = {
      id: item.id,
      url: item.url,
      platform: item.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
      embedId: item.embedId,
      title: item.title,
      thumbnail: item.thumbnail,
      addedAt: item.addedAt,
      addedBy: ctx.userId || 'unknown',
      addedByName: ctx.userName || 'Anonymous'
    };
    logToHistory(historyItem);

    renderUI();
    return { success: true, message: result.message || 'Added to queue' };
  } catch (error: unknown) {
    log.error('Error adding item:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add to queue' };
  }
}

// ============================================
// REMOVE ITEM
// ============================================

export async function removeItem(
  ctx: PlaylistContext,
  itemId: string,
  getAuthToken: () => Promise<string | null>,
  renderUI: () => void,
): Promise<void> {
  if (!ctx.isAuthenticated || !ctx.userId) {
    log.warn('Must be authenticated to remove items');
    return;
  }

  try {
    const idToken = await getAuthToken();
    const deleteHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idToken) deleteHeaders['Authorization'] = `Bearer ${idToken}`;

    const removeController = new AbortController();
    const removeTimeoutId = setTimeout(() => removeController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/global/', {
      method: 'DELETE',
      headers: deleteHeaders,
      body: JSON.stringify({
        itemId,
        userId: ctx.userId
      }),
      signal: removeController.signal
    });
    clearTimeout(removeTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (!result.success) {
      log.error('Remove failed:', result.error);
      return;
    }

    // Update local state
    if (result.playlist) {
      ctx.playlist = result.playlist;

      // If queue is empty, cleanup
      if (ctx.playlist.queue.length === 0) {
        if (ctx.player) await ctx.player.destroy();
        disableEmojis();
        updateNowPlayingDisplay(null);
        showOfflineOverlay();
      }
    }

    renderUI();
  } catch (error: unknown) {
    log.error('Error removing item:', error);
  }
}

// ============================================
// SUBSCRIBE TO PUSHER
// ============================================

export async function subscribeToPusher(
  ctx: PlaylistContext,
  handleRemoteUpdateFn: (data: GlobalPlaylist) => Promise<void>,
): Promise<void> {
  if (ctx.isSubscribed) return;

  // Wait for Pusher to be available
  const maxWait = TIMEOUTS.API;
  const startTime = Date.now();

  while (!window.Pusher && Date.now() - startTime < maxWait) {
    await new Promise(resolve => setTimeout(resolve, TIMEOUTS.POLL));
  }

  if (!window.Pusher) {
    log.warn('Pusher not available, no real-time sync');
    return;
  }

  // Get Pusher config from window
  const pusherConfig = window.PUSHER_CONFIG;
  if (!pusherConfig?.key) {
    log.warn('Pusher config not found');
    return;
  }

  try {
    // Use existing Pusher instance if available, or create new one
    let pusher = window.pusherInstance;
    if (!pusher) {
      pusher = new window.Pusher(pusherConfig.key, {
        cluster: pusherConfig.cluster || 'eu',
        forceTLS: true
      });
      window.pusherInstance = pusher;
    }

    // Subscribe to playlist channel
    ctx.pusherChannel = pusher.subscribe('live-playlist');

    ctx.pusherChannel!.bind('playlist-update', (data: GlobalPlaylist) => {
      handleRemoteUpdateFn(data);
    });

    ctx.isSubscribed = true;
  } catch (error: unknown) {
    log.error('Pusher subscription error:', error);
  }
}

// ============================================
// HANDLE REMOTE UPDATE
// ============================================

export async function handleRemoteUpdate(
  ctx: PlaylistContext,
  newPlaylist: GlobalPlaylist & { recentlyPlayed?: Record<string, unknown>[] },
  playCurrent: () => Promise<void>,
  renderUI: () => void,
): Promise<void> {
  // If live stream is active, ignore "isPlaying" from remote updates
  const liveStreamActive = window.isLiveStreamActive;
  if (liveStreamActive && newPlaylist.isPlaying) {
    newPlaylist.isPlaying = false;
  }

  const wasPlaying = ctx.playlist.isPlaying;
  const oldCurrentItem = ctx.playlist.queue[ctx.playlist.currentIndex];
  const hadItems = ctx.playlist.queue.length > 0;

  // Extract and store recently played from Pusher (if included)
  if (newPlaylist.recentlyPlayed) {
    ctx.globalRecentlyPlayed = newPlaylist.recentlyPlayed;
  }

  // Update local playlist (exclude recentlyPlayed from playlist object)
  // But preserve local titles if we have better (non-placeholder) titles
  const { recentlyPlayed: _, ...playlistWithoutRecent } = newPlaylist;
  const oldQueue = ctx.playlist.queue;
  ctx.playlist = playlistWithoutRecent as GlobalPlaylist;

  // Preserve better titles from local queue
  ctx.playlist.queue = ctx.playlist.queue.map(item => {
    const oldItem = oldQueue.find(old => old.id === item.id);
    if (oldItem && !isPlaceholderTitle(oldItem.title) && isPlaceholderTitle(item.title)) {
      return { ...item, title: oldItem.title };
    }
    return item;
  });

  const newCurrentItem = ctx.playlist.queue[ctx.playlist.currentIndex];
  const hasItems = ctx.playlist.queue.length > 0;

  // Case 1: Queue became empty (all tracks finished)
  if (hadItems && !hasItems) {
    clearTrackTimer(ctx);
    stopCountdown(ctx);
    if (ctx.player) await ctx.player.destroy();
    disableEmojis();
    updateNowPlayingDisplay(null);
    showOfflineOverlay();
    renderUI();
    return;
  }

  // Case 2: Queue is empty and was already empty
  if (!hasItems) {
    renderUI();
    return;
  }

  const shouldStartPlaying = !wasPlaying && ctx.playlist.isPlaying && hasItems;
  const currentItemChanged = oldCurrentItem?.id !== newCurrentItem?.id && newCurrentItem != null;

  if (shouldStartPlaying) {
    await playCurrent();
  } else if (ctx.playlist.isPlaying && currentItemChanged) {
    await playCurrent();
  } else if (!ctx.playlist.isPlaying && wasPlaying) {
    stopCountdown(ctx);
    if (ctx.player) await ctx.player.pause();
    disableEmojis();
  }

  renderUI();
}

// ============================================
// LOAD FROM SERVER
// ============================================

export async function loadFromServer(ctx: PlaylistContext): Promise<void> {
  try {
    const loadController = new AbortController();
    const loadTimeoutId = setTimeout(() => loadController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/global/', {
      signal: loadController.signal
    });
    clearTimeout(loadTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (result.success && result.playlist) {
      ctx.playlist = result.playlist;

      // If live stream is active, force playlist to not play
      if (window.isLiveStreamActive && ctx.playlist.isPlaying) {
        ctx.playlist.isPlaying = false;
      }

      // Check for stale or invalid playlist states
      let shouldClear = false;

      // Case 1: isPlaying is true but queue is empty
      if (ctx.playlist.isPlaying && ctx.playlist.queue.length === 0) {
        shouldClear = true;
      }

      // Case 3: trackStartedAt is more than 15 minutes old
      if (ctx.playlist.isPlaying && ctx.playlist.trackStartedAt) {
        const startedAt = new Date(ctx.playlist.trackStartedAt).getTime();
        const now = Date.now();
        const elapsedMs = now - startedAt;
        const maxTrackMs = 15 * 60 * 1000; // 15 minutes max (buffer over 10 min limit)

        if (elapsedMs > maxTrackMs) {
          shouldClear = true;
        }
      }

      if (shouldClear) {
        await clearStalePlaylist(ctx);
      }
    }
  } catch (error: unknown) {
    log.error('Error loading from server:', error);
  }
}

async function clearStalePlaylist(ctx: PlaylistContext): Promise<void> {
  try {
    ctx.playlist = {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString(),
      trackStartedAt: undefined
    };

    const staleController = new AbortController();
    const staleTimeoutId = setTimeout(() => staleController.abort(), TIMEOUTS.API_EXTENDED);

    await fetch('/api/playlist/global/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        playlist: ctx.playlist
      }),
      signal: staleController.signal
    });
    clearTimeout(staleTimeoutId);

  } catch (error: unknown) {
    log.error('Error clearing stale playlist:', error);
  }
}

// ============================================
// PERSONAL PLAYLIST
// ============================================

export async function addToPersonalPlaylist(
  ctx: PlaylistContext,
  url: string,
  generateId: () => string,
  renderUI: () => void,
  providedTitle?: string,
  providedThumbnail?: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  if (!url || !url.trim()) return { success: false, error: 'Please enter a URL' };
  try {
    const { parseMediaUrl } = await import('../url-parser');
    const parsed = parseMediaUrl(url.trim());
    if (!parsed.isValid) return { success: false, error: parsed.error || 'Invalid URL' };

    let title = providedTitle;
    let thumbnail = providedThumbnail;
    if (!title || !thumbnail) {
      const metadata = await fetchMetadata(url.trim());
      title = title || metadata.title;
      thumbnail = thumbnail || metadata.thumbnail;
    }
    if (!thumbnail && parsed.platform === 'youtube' && parsed.embedId) {
      thumbnail = `https://img.youtube.com/vi/${parsed.embedId}/mqdefault.jpg`;
    }

    const newItem: PersonalPlaylistItem = {
      id: generateId(), url: url.trim(), platform: parsed.platform,
      embedId: parsed.embedId, title: title || 'Untitled', thumbnail,
      addedAt: new Date().toISOString()
    };

    const result = addToPersonalPlaylistItems(ctx.personalPlaylist, newItem);
    if (!result.added) return { success: false, error: result.error };

    ctx.personalPlaylist = result.items;
    savePersonalPlaylistToStorage(ctx.personalPlaylist);
    if (ctx.userId) savePersonalPlaylistToServer(ctx.personalPlaylist, ctx.userId);
    renderUI();
    return { success: true, message: 'Added to your playlist' };
  } catch (error: unknown) {
    log.error('Error adding to personal playlist:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add to playlist' };
  }
}

export function removeFromPersonalPlaylist(
  ctx: PlaylistContext,
  itemId: string,
  renderUI: () => void,
): void {
  const newItems = removeFromPersonalPlaylistItems(ctx.personalPlaylist, itemId);
  if (newItems !== ctx.personalPlaylist) {
    ctx.personalPlaylist = newItems;
    savePersonalPlaylistToStorage(ctx.personalPlaylist);
    if (ctx.userId) savePersonalPlaylistToServer(ctx.personalPlaylist, ctx.userId);
    renderUI();
  }
}

export function clearPersonalPlaylist(
  ctx: PlaylistContext,
  renderUI: () => void,
): void {
  ctx.personalPlaylist = [];
  savePersonalPlaylistToStorage(ctx.personalPlaylist);
  if (ctx.userId) savePersonalPlaylistToServer(ctx.personalPlaylist, ctx.userId);
  renderUI();
}
