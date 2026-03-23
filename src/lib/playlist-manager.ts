// src/lib/playlist-manager.ts
// Global playlist manager - synced across all viewers via Pusher
// Core orchestration class — heavy logic extracted to ./playlist-manager/ sub-modules.

import type { GlobalPlaylistItem, GlobalPlaylist } from './types';
// EmbedPlayerManager and parseMediaUrl are dynamically imported to split the bundle.
// embed-player.ts (~30KB) is only needed when playback starts.
// url-parser.ts is only needed when adding items to the queue.
import type { EmbedPlayerManager } from './embed-player';
import { createClientLogger } from './client-logger';
import { TIMEOUTS } from './timeouts';
import { MAX_CONSECUTIVE_ERRORS } from './constants/limits';

// Sub-module imports
import {
  MAX_TRACK_DURATION_MS,
  MAX_TRACK_DURATION_SECONDS,
} from './playlist-manager/types';
import type { PlaylistHistoryEntry, PersonalPlaylistItem } from './playlist-manager/types';
import {
  isPlaceholderTitle,
  fetchMetadata,
  fetchVideoDuration,
} from './playlist-manager/metadata';
import {
  loadRecentlyPlayedFromStorage,
  saveRecentlyPlayedToStorage,
  wasPlayedRecently,
  loadPlayHistoryFromStorage,
  savePlayHistoryToStorage,
  logToHistoryArray,
} from './playlist-manager/history';
import {
  loadPersonalPlaylistFromStorage,
  savePersonalPlaylistToStorage,
  savePersonalPlaylistToServer,
  loadPersonalPlaylistFromServer,
  addToPersonalPlaylistItems,
  removeFromPersonalPlaylistItems,
} from './playlist-manager/personal-playlist';
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
} from './playlist-manager/ui';

const log = createClientLogger('PlaylistManager');

export class PlaylistManager {
  private userId: string | null = null;
  private userName: string | null = null;
  private playlist: GlobalPlaylist;
  private player: EmbedPlayerManager | null = null; // Lazy-loaded on first playback
  private playerPromise: Promise<EmbedPlayerManager> | null = null; // Loading guard
  private isAuthenticated: boolean = false;
  public wasPausedForStream: boolean = false;
  private playHistory: PlaylistHistoryEntry[] = [];
  private personalPlaylist: PersonalPlaylistItem[] = []; // User's saved tracks
  private pusherChannel: { bind: (event: string, callback: (...args: unknown[]) => void) => void; unbind_all: () => void } | null = null;
  private isSubscribed: boolean = false;
  private trackTimer: number | null = null; // Timer for max track duration
  private recentlyPlayed: Map<string, number> = new Map(); // URL -> timestamp
  private globalRecentlyPlayed: Record<string, unknown>[] = []; // Recently played from Pusher (global)
  private countdownInterval: number | null = null; // Countdown display interval
  private countdownTrackId: string | null = null; // Track ID countdown is running for
  private isFetchingDuration: boolean = false; // Prevent duplicate duration fetches
  private consecutiveErrors: number = 0; // Track errors to prevent infinite loops
  private containerId: string; // Store container ID for existence check
  private lastPlayedUrl: string | null = null; // Track last played URL to avoid immediate repeats
  private isPlayingLocked: boolean = false; // Prevent concurrent play operations
  private pendingPlayRequest: boolean = false; // Queue a play request if locked
  private isPausedLocally: boolean = false; // Track if user has paused locally
  private playbackStartedTime: number = 0; // Timestamp when playback started (for stable play detection)

  constructor(containerId: string) {
    this.containerId = containerId;
    this.playlist = {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString()
    };

    // EmbedPlayerManager is lazy-loaded on first playback to reduce initial bundle size.
    // The player is created by ensurePlayer() when playback is needed.

    // Load play history, recently played, and personal playlist
    this.playHistory = loadPlayHistoryFromStorage();
    this.recentlyPlayed = loadRecentlyPlayedFromStorage();
    this.personalPlaylist = loadPersonalPlaylistFromStorage();
  }

  /**
   * Lazy-load and create the EmbedPlayerManager on first use.
   * This defers ~30KB of embed-player.ts until playback actually starts.
   */
  private async ensurePlayer(): Promise<EmbedPlayerManager> {
    if (this.player) return this.player;

    // Prevent duplicate loading (multiple callers awaiting simultaneously)
    if (this.playerPromise) return this.playerPromise;

    this.playerPromise = (async () => {
      const { EmbedPlayerManager: PlayerClass } = await import('./embed-player');
      this.player = new PlayerClass(this.containerId, {
        onEnded: () => this.handleTrackEnded(),
        onError: (error) => this.handlePlaybackError(error),
        onReady: () => this.handlePlayerReady(),
        onStateChange: (state) => this.handleStateChange(state),
        onTitleUpdate: (title) => this.handleTitleUpdate(title)
      });
      return this.player;
    })();

    return this.playerPromise;
  }

  // ============================================
  // RECENTLY PLAYED (thin wrappers)
  // ============================================

  private markAsPlayed(url: string): void {
    this.lastPlayedUrl = url; // Track for immediate repeat prevention
    this.recentlyPlayed.set(url, Date.now());
    saveRecentlyPlayedToStorage(this.recentlyPlayed);
  }

  // ============================================
  // TRACK TIMER
  // ============================================

  private startTrackTimer(): void {
    this.clearTrackTimer();
    this.trackTimer = window.setTimeout(() => {
      this.handleTrackEnded();
    }, MAX_TRACK_DURATION_MS);
  }

  private clearTrackTimer(): void {
    if (this.trackTimer) {
      clearTimeout(this.trackTimer);
      this.trackTimer = null;
    }
  }

  // ============================================
  // INITIALIZE
  // ============================================

  async initialize(userId?: string, userName?: string): Promise<void> {
    this.userId = userId || null;
    this.userName = userName || null;
    this.isAuthenticated = !!userId;

    // Load global playlist from server
    await this.loadFromServer();

    // Load personal playlist from D1 if authenticated
    if (this.isAuthenticated && this.userId) {
      const result = await loadPersonalPlaylistFromServer(this.userId, this.personalPlaylist);
      if (result.changed) {
        this.personalPlaylist = result.items;
        // Save merged list back to both localStorage and D1
        savePersonalPlaylistToStorage(this.personalPlaylist);
        savePersonalPlaylistToServer(this.personalPlaylist, this.userId);
      }
    }

    // Subscribe to Pusher for real-time updates
    await this.subscribeToPusher();

    // If playlist is playing, start playback
    if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
      await this.playCurrent();
    } else if (this.playlist.queue.length === 0 && !window.isLiveStreamActive) {
      // Queue is empty and no live stream - try to auto-start playlist
      // Small delay to ensure page is ready
      setTimeout(() => this.startAutoPlay(), TIMEOUTS.ANIMATION);
    }

    this.renderUI();
  }

  // ============================================
  // PUSHER SYNC
  // ============================================

  private async subscribeToPusher(): Promise<void> {
    if (this.isSubscribed) return;

    // Wait for Pusher to be available
    const maxWait = TIMEOUTS.API;
    const startTime = Date.now();

    while (!window.Pusher && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
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
      this.pusherChannel = pusher.subscribe('live-playlist');

      this.pusherChannel.bind('playlist-update', (data: GlobalPlaylist) => {
        this.handleRemoteUpdate(data);
      });

      this.isSubscribed = true;
    } catch (error: unknown) {
      log.error('Pusher subscription error:', error);
    }
  }

  private async handleRemoteUpdate(newPlaylist: GlobalPlaylist & { recentlyPlayed?: Record<string, unknown>[] }): Promise<void> {
    // If live stream is active, ignore "isPlaying" from remote updates
    const liveStreamActive = window.isLiveStreamActive;
    if (liveStreamActive && newPlaylist.isPlaying) {
      newPlaylist.isPlaying = false; // Force playlist to not play
    }

    const wasPlaying = this.playlist.isPlaying;
    const oldCurrentItem = this.playlist.queue[this.playlist.currentIndex];
    const hadItems = this.playlist.queue.length > 0;

    // Extract and store recently played from Pusher (if included)
    if (newPlaylist.recentlyPlayed) {
      this.globalRecentlyPlayed = newPlaylist.recentlyPlayed;
    }

    // Update local playlist (exclude recentlyPlayed from playlist object)
    // But preserve local titles if we have better (non-placeholder) titles
    const { recentlyPlayed: _, ...playlistWithoutRecent } = newPlaylist;
    const oldQueue = this.playlist.queue;
    this.playlist = playlistWithoutRecent as GlobalPlaylist;

    // Preserve better titles from local queue (prevents Pusher from overwriting fetched titles)
    this.playlist.queue = this.playlist.queue.map(item => {
      const oldItem = oldQueue.find(old => old.id === item.id);
      if (oldItem && !isPlaceholderTitle(oldItem.title) && isPlaceholderTitle(item.title)) {
        // Local has real title, remote has placeholder - keep local title
        return { ...item, title: oldItem.title };
      }
      return item;
    });

    const newCurrentItem = this.playlist.queue[this.playlist.currentIndex];
    const hasItems = this.playlist.queue.length > 0;

    // Case 1: Queue became empty (all tracks finished)
    if (hadItems && !hasItems) {
      this.clearTrackTimer();
      this.stopCountdown();
      if (this.player) await this.player.destroy();
      disableEmojis();
      updateNowPlayingDisplay(null);
      showOfflineOverlay();
      this.renderUI();
      return;
    }

    // Case 2: Queue is empty and was already empty
    if (!hasItems) {
      this.renderUI();
      return;
    }

    // Determine if we need to change what's playing:
    // 1. We weren't playing but should start now (first item added)
    // 2. The actual item at currentIndex changed (e.g., "next" was triggered or track was removed)
    const shouldStartPlaying = !wasPlaying && this.playlist.isPlaying && hasItems;
    const currentItemChanged = oldCurrentItem?.id !== newCurrentItem?.id && newCurrentItem != null;

    if (shouldStartPlaying) {
      // Starting playback for the first time
      await this.playCurrent();
    } else if (this.playlist.isPlaying && currentItemChanged) {
      // The current track changed (next/skip was triggered, not just queue addition)
      await this.playCurrent();
    } else if (!this.playlist.isPlaying && wasPlaying) {
      // Playlist was paused remotely
      this.stopCountdown();
      if (this.player) await this.player.pause();
      disableEmojis();
    }
    // If just adding items to queue while playing, do nothing - let current track continue

    this.renderUI();
  }

  // ============================================
  // ADD / REMOVE ITEMS
  // ============================================

  async addItem(url: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!url || !url.trim()) {
      return { success: false, error: 'Please enter a URL' };
    }

    if (!this.isAuthenticated || !this.userId) {
      return { success: false, error: 'Please sign in to add to playlist' };
    }

    // Check if URL was played recently (within 1 hour)
    const recentCheck = wasPlayedRecently(this.recentlyPlayed, url.trim());
    if (recentCheck.recent) {
      return {
        success: false,
        error: `This track was played recently. Try again in ${recentCheck.minutesRemaining} minutes.`
      };
    }

    // Check if URL is already in the current queue
    const alreadyInQueue = this.playlist.queue.some(item => item.url === url.trim());
    if (alreadyInQueue) {
      return { success: false, error: 'This track is already in the queue' };
    }

    // DJ Waitlist: Check if user already has max tracks in queue (2 tracks per DJ)
    const userTracksInQueue = this.playlist.queue.filter(item => item.addedBy === this.userId).length;
    if (userTracksInQueue >= 2) {
      return { success: false, error: 'You already have 2 tracks in the queue. Wait for one to play or remove it first.' };
    }

    try {
      // Parse URL locally first (dynamically imported to reduce initial bundle)
      const { parseMediaUrl } = await import('./url-parser');
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
        id: this.generateId(),
        url: url.trim(),
        platform: parsed.platform,
        embedId: parsed.embedId,
        title: metadata.title,
        thumbnail,
        addedAt: new Date().toISOString()
      };

      // Send to global API
      const idToken = await this.getAuthToken();
      const postHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) postHeaders['Authorization'] = `Bearer ${idToken}`;

      const addController = new AbortController();
      const addTimeoutId = setTimeout(() => addController.abort(), TIMEOUTS.API_EXTENDED);

      const response = await fetch('/api/playlist/global/', {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({
          item,
          userId: this.userId,
          userName: this.userName || 'Anonymous'
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
        this.playlist = result.playlist;

        // Auto-play if this is the first item
        if (this.playlist.queue.length === 1 && this.playlist.isPlaying) {
          await this.playCurrent();
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
        addedBy: this.userId || 'unknown',
        addedByName: this.userName || 'Anonymous'
      };
      this.logToHistory(historyItem);

      this.renderUI();
      return { success: true, message: result.message || 'Added to queue' };
    } catch (error: unknown) {
      log.error('Error adding item:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add to queue' };
    }
  }

  async removeItem(itemId: string): Promise<void> {
    if (!this.isAuthenticated || !this.userId) {
      log.warn('Must be authenticated to remove items');
      return;
    }

    try {
      const idToken = await this.getAuthToken();
      const deleteHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) deleteHeaders['Authorization'] = `Bearer ${idToken}`;

      const removeController = new AbortController();
      const removeTimeoutId = setTimeout(() => removeController.abort(), TIMEOUTS.API_EXTENDED);

      const response = await fetch('/api/playlist/global/', {
        method: 'DELETE',
        headers: deleteHeaders,
        body: JSON.stringify({
          itemId,
          userId: this.userId
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
        this.playlist = result.playlist;

        // If queue is empty, cleanup
        if (this.playlist.queue.length === 0) {
          if (this.player) await this.player.destroy();
          disableEmojis();
          updateNowPlayingDisplay(null);
          showOfflineOverlay();
        }
      }

      this.renderUI();
    } catch (error: unknown) {
      log.error('Error removing item:', error);
    }
  }

  // ============================================
  // PLAY / PAUSE / RESUME
  // ============================================

  async play(): Promise<void> {
    // Don't play if live stream is active
    if (window.isLiveStreamActive) {
      return;
    }

    if (this.playlist.queue.length === 0) {
      log.warn('Cannot play - queue is empty');
      return;
    }

    // Update server state
    await this.sendControlAction('play');
  }

  async pause(): Promise<void> {
    this.isPausedLocally = true; // Set local pause flag
    this.clearTrackTimer();
    this.stopCountdown();
    if (this.player) await this.player.pause();
    stopPlaylistMeters();
    disableEmojis();
  }

  async resume(): Promise<void> {
    if (this.playlist.queue.length === 0) return;

    this.isPausedLocally = false; // Clear local pause flag

    // Fetch latest playlist state to get current trackStartedAt
    try {
      const resumeController = new AbortController();
      const resumeTimeoutId = setTimeout(() => resumeController.abort(), TIMEOUTS.API_EXTENDED);

      const response = await fetch('/api/playlist/global/', {
        signal: resumeController.signal
      });
      clearTimeout(resumeTimeoutId);

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const result = await response.json();
      if (result.success && result.playlist) {
        this.playlist = result.playlist;
      }
    } catch (error: unknown) {
      log.warn('Could not fetch latest state:', error);
    }

    // Resume and sync to current global position
    const player = await this.ensurePlayer();
    await player.play();
    enableEmojis();

    // Seek to current global position
    const syncPosition = this.calculateSyncPosition();
    if (syncPosition > 2) {
      await player.seekTo(syncPosition);
    }

    // Restart countdown display
    this.updateDurationDisplay();

  }

  async playNext(): Promise<void> {
    if (this.playlist.queue.length === 0) return;
    await this.sendControlAction('next');
  }

  async skipTrack(): Promise<void> {
    if (this.playlist.queue.length === 0) {
      log.warn('Cannot skip - queue is empty');
      return;
    }
    await this.handleTrackEnded();
  }

  // ============================================
  // AUTO-PLAY
  // ============================================

  async startAutoPlay(): Promise<boolean> {
    // Don't start if live stream is active
    if (window.isLiveStreamActive) {
      return false;
    }

    // Don't start if already playing or queue has items
    if (this.playlist.isPlaying || this.playlist.queue.length > 0) {
      return false;
    }

    // Check if container exists
    const container = document.getElementById(this.containerId);
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
        this.playlist = result.playlist;

        if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
          await this.playCurrent();
          this.renderUI();
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
  // CONTROL ACTIONS
  // ============================================

  private async sendControlAction(action: string): Promise<void> {
    try {
      const controlController = new AbortController();
      const controlTimeoutId = setTimeout(() => controlController.abort(), TIMEOUTS.API_EXTENDED);

      const response = await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          userId: this.userId
        }),
        signal: controlController.signal
      });
      clearTimeout(controlTimeoutId);

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const result = await response.json();

      if (result.success && result.playlist) {
        this.playlist = result.playlist;

        if (action === 'play' || action === 'next') {
          await this.playCurrent();
        } else if (action === 'pause') {
          if (this.player) await this.player.pause();
          disableEmojis();
        }

        this.renderUI();
      }
    } catch (error: unknown) {
      log.error('Control action error:', error);
    }
  }

  async clearQueue(): Promise<void> {
    // For now, just clear locally
    this.playlist.queue = [];
    this.playlist.currentIndex = 0;
    this.playlist.isPlaying = false;

    if (this.player) await this.player.destroy();
    disableEmojis();
    updateNowPlayingDisplay(null);
    showOfflineOverlay();
    this.renderUI();
  }

  // ============================================
  // SYNC POSITION
  // ============================================

  private calculateSyncPosition(): number {
    if (!this.playlist.trackStartedAt) {
      return 0;
    }

    const startedAt = new Date(this.playlist.trackStartedAt).getTime();
    const now = Date.now();
    const elapsedSeconds = Math.floor((now - startedAt) / 1000);

    // Cap at 10 minutes (max track duration)
    const maxSeconds = MAX_TRACK_DURATION_MS / 1000;
    return Math.min(Math.max(0, elapsedSeconds), maxSeconds);
  }

  // ============================================
  // PLAY CURRENT (core orchestration)
  // ============================================

  private async playCurrent(): Promise<void> {
    // Don't play if live stream is active
    if (window.isLiveStreamActive) {
      return;
    }

    const currentItem = this.playlist.queue[this.playlist.currentIndex];
    if (!currentItem) return;

    // Clear local pause flag when starting playback
    this.isPausedLocally = false;

    // Check if container exists before trying to play
    // (prevents errors when playlist manager exists but player isn't on page)
    const container = document.getElementById(this.containerId);
    if (!container) {
      log.warn('Player container not found - skipping playback');
      return;
    }

    // Prevent concurrent play operations (race condition fix)
    if (this.isPlayingLocked) {
      this.pendingPlayRequest = true;
      return;
    }

    this.isPlayingLocked = true;
    this.pendingPlayRequest = false;

    try {
      // Show video player and hide overlays
      showVideoPlayer(() => this.hidePlaylistLoadingOverlay());

      // Log to local play history only (server history updated when track ENDS)
      this.logToHistory(currentItem);

      // Mark URL as played (for 1-hour cooldown)
      this.markAsPlayed(currentItem.url);

      // Start 10-minute timer
      this.startTrackTimer();

      // Enable emoji reactions
      enableEmojis();

      // Update NOW PLAYING display
      updateNowPlayingDisplay(currentItem);

      // Lazy-load embed player on first playback
      const player = await this.ensurePlayer();

      // Calculate sync position BEFORE loading the item
      const syncPosition = this.calculateSyncPosition();
      if (syncPosition > 2) { // Only seek if more than 2 seconds in
        player.setPendingSeek(syncPosition);
      }

      await player.loadItem(currentItem);

      // Check duration after loading - skip if exceeds 10 minute limit
      try {
        // Wait a moment for player to have duration info
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.TICK));
        const duration = await player.getDuration();

        if (duration > MAX_TRACK_DURATION_SECONDS) {
          this.clearTrackTimer();
          // Don't unlock yet - let handleTrackEnded handle it
          this.isPlayingLocked = false;
          await this.handleTrackEnded();
          return;
        }
      } catch (e: unknown) {
        log.warn('Could not check duration, allowing track to play:', e);
      }

      this.renderUI();

    } catch (error: unknown) {
      log.error('Error playing current:', error);
      // Remove failed track and pick a new one (maintains single-track queue for autoplay)
      await this.handleTrackEnded();
    } finally {
      this.isPlayingLocked = false;

      // If there was a pending play request, execute it
      if (this.pendingPlayRequest) {
        this.pendingPlayRequest = false;
        // Use setTimeout to avoid stack overflow
        setTimeout(() => this.playCurrent(), 50);
      }
    }
  }

  // ============================================
  // HISTORY (thin wrappers around extracted functions)
  // ============================================

  private logToHistory(item: GlobalPlaylistItem): void {
    this.playHistory = logToHistoryArray(this.playHistory, item);
    savePlayHistoryToStorage(this.playHistory);
  }

  getPlayHistory(): PlaylistHistoryEntry[] {
    return [...this.playHistory];
  }

  clearPlayHistory(): void {
    this.playHistory = [];
    savePlayHistoryToStorage(this.playHistory);
  }

  // ============================================
  // PERSONAL PLAYLIST (thin wrappers)
  // ============================================

  async addToPersonalPlaylist(url: string, providedTitle?: string, providedThumbnail?: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!url || !url.trim()) {
      return { success: false, error: 'Please enter a URL' };
    }

    try {
      // Parse URL (dynamically imported to reduce initial bundle)
      const { parseMediaUrl } = await import('./url-parser');
      const parsed = parseMediaUrl(url.trim());

      if (!parsed.isValid) {
        return { success: false, error: parsed.error || 'Invalid URL' };
      }

      // Use provided title/thumbnail or fetch metadata
      let title = providedTitle;
      let thumbnail = providedThumbnail;

      if (!title || !thumbnail) {
        const metadata = await fetchMetadata(url.trim());
        title = title || metadata.title;
        thumbnail = thumbnail || metadata.thumbnail;
      }

      // Fallback thumbnail for YouTube
      if (!thumbnail && parsed.platform === 'youtube' && parsed.embedId) {
        thumbnail = `https://img.youtube.com/vi/${parsed.embedId}/mqdefault.jpg`;
      }

      const newItem: PersonalPlaylistItem = {
        id: this.generateId(),
        url: url.trim(),
        platform: parsed.platform,
        embedId: parsed.embedId,
        title: title || 'Untitled',
        thumbnail,
        addedAt: new Date().toISOString()
      };

      const result = addToPersonalPlaylistItems(this.personalPlaylist, newItem);
      if (!result.added) {
        return { success: false, error: result.error };
      }

      this.personalPlaylist = result.items;
      savePersonalPlaylistToStorage(this.personalPlaylist);
      if (this.userId) savePersonalPlaylistToServer(this.personalPlaylist, this.userId);
      this.renderUI();

      return { success: true, message: 'Added to your playlist' };
    } catch (error: unknown) {
      log.error('Error adding to personal playlist:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add to playlist' };
    }
  }

  removeFromPersonalPlaylist(itemId: string): void {
    const newItems = removeFromPersonalPlaylistItems(this.personalPlaylist, itemId);
    if (newItems !== this.personalPlaylist) {
      this.personalPlaylist = newItems;
      savePersonalPlaylistToStorage(this.personalPlaylist);
      if (this.userId) savePersonalPlaylistToServer(this.personalPlaylist, this.userId);
      this.renderUI();
    }
  }

  async addPersonalItemToQueue(itemId: string): Promise<{ success: boolean; message?: string; error?: string }> {
    const item = this.personalPlaylist.find(i => i.id === itemId);
    if (!item) {
      return { success: false, error: 'Track not found in your playlist' };
    }

    // Use the existing addItem method which handles all validation
    const result = await this.addItem(item.url);

    // If successfully added to queue, optionally remove from personal playlist
    // (keeping it for now - user can manually remove if they want)

    return result;
  }

  getPersonalPlaylist(): PersonalPlaylistItem[] {
    return [...this.personalPlaylist];
  }

  clearPersonalPlaylist(): void {
    this.personalPlaylist = [];
    savePersonalPlaylistToStorage(this.personalPlaylist);
    if (this.userId) savePersonalPlaylistToServer(this.personalPlaylist, this.userId);
    this.renderUI();
  }

  // ============================================
  // DURATION DISPLAY (orchestration that calls ui.ts helpers)
  // ============================================

  private async updateDurationDisplay(): Promise<void> {
    const currentTrack = this.playlist.queue[this.playlist.currentIndex];
    const currentTrackId = currentTrack?.id;

    // Skip if countdown is already running for this track
    if (this.countdownInterval && this.countdownTrackId === currentTrackId) {
      return;
    }

    // Skip if already fetching duration for this track (prevents --:-- flash)
    if (this.isFetchingDuration && this.countdownTrackId === currentTrackId) {
      return;
    }

    // Clear any existing countdown
    this.stopCountdown();

    // Track which track this countdown is for (set BEFORE async operations)
    this.countdownTrackId = currentTrackId || null;

    // Show immediate countdown estimate using trackStartedAt while we wait for metadata
    // This prevents the blank/sporadic display on page load
    const trackStartedAt = this.playlist.trackStartedAt
      ? new Date(this.playlist.trackStartedAt).getTime()
      : null;

    if (trackStartedAt && (currentTrack as GlobalPlaylistItem & { duration?: number })?.duration) {
      // We have server start time + stored duration -- show countdown immediately
      this.countdownInterval = startCountdown(
        (currentTrack as GlobalPlaylistItem & { duration?: number }).duration!,
        trackStartedAt
      );
    }

    // Now fetch accurate duration from player metadata (may refine the countdown)
    this.isFetchingDuration = true;
    let duration = 0;
    try {
      const player = await this.ensurePlayer();
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

    this.isFetchingDuration = false;

    if (duration > 0) {
      // Restart countdown with accurate duration from player
      this.stopCountdown();
      this.countdownTrackId = currentTrackId || null;
      this.countdownInterval = startCountdown(duration, trackStartedAt);
    } else if (!this.countdownInterval) {
      // No duration from any source and no countdown running -- show elapsed
      this.countdownInterval = startElapsedTimer(this.playlist.trackStartedAt);
    }
  }

  private stopCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.countdownTrackId = null;
  }

  // ============================================
  // OVERLAYS (thin wrappers that delegate to ui.ts)
  // ============================================

  public hidePlaylistLoadingOverlay(): void {
    hidePlaylistLoadingOverlay();
  }

  // ============================================
  // TRACK ENDED / PLAYBACK ERROR
  // ============================================

  private async handleTrackEnded(): Promise<void> {
    // Clear all timers first
    this.clearTrackTimer();
    this.stopCountdown();

    // Capture the track ID before delay to detect if Pusher updates during wait
    const trackIdBeforeDelay = this.playlist.queue[this.playlist.currentIndex]?.id;

    // RACE PREVENTION: Add small random delay (0-300ms) to stagger requests from multiple clients
    // This gives the first client time to complete and broadcast via Pusher
    const delay = Math.floor(Math.random() * 300);
    await new Promise(resolve => setTimeout(resolve, delay));

    // Check if Pusher already updated us with a new track during the delay
    const finishedItem = this.playlist.queue[this.playlist.currentIndex];
    if (!finishedItem) {
      return;
    }

    // If the track changed during the delay, Pusher already synced us - don't send redundant request
    if (finishedItem.id !== trackIdBeforeDelay) {
      return;
    }

    // Tell the SERVER to handle track end - it will pick the next track
    // This ensures all clients play the same track (server is source of truth)
    try {
      const endedController = new AbortController();
      const endedTimeoutId = setTimeout(() => endedController.abort(), TIMEOUTS.API_EXTENDED);

      const response = await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'trackEnded',
          trackId: finishedItem.id, // Prevent race conditions
          finishedTrackTitle: finishedItem.title // Send resolved title for recently played
        }),
        signal: endedController.signal
      });
      clearTimeout(endedTimeoutId);

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const result = await response.json();
      if (result.success && result.playlist) {
        // Update local state with server response (server is source of truth)
        this.playlist = result.playlist;

        // Play the new track (whether we were first or not - server has the correct track)
        if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
          await this.playCurrent();
        } else {
          // No tracks - show offline state
          if (this.player) await this.player.destroy();
          disableEmojis();
          updateNowPlayingDisplay(null);
          showOfflineOverlay();
        }
      }
    } catch (error: unknown) {
      log.error('Error calling trackEnded:', error);
      // Fallback: just stop playback on error
      this.playlist.isPlaying = false;
      if (this.player) await this.player.destroy();
      disableEmojis();
      updateNowPlayingDisplay(null);
      showOfflineOverlay();
    }

    this.renderUI();
  }

  private async handlePlaybackError(error: string): Promise<void> {
    log.error('Playback error:', error);

    // Check if container exists - if not, stop trying
    const container = document.getElementById(this.containerId);
    if (!container) {
      log.warn('Container not found - player may not be on this page. Stopping playback attempts.');
      this.consecutiveErrors = 0;
      return;
    }

    // Parse structured error info (from enhanced YouTube error handling)
    let errorInfo: { type?: string; code?: number; message?: string } = {};
    try {
      errorInfo = JSON.parse(error);
    } catch (_e: unknown) {
      /* intentional: legacy error format is a plain string, not JSON */
      errorInfo = { type: 'error', message: error };
    }

    const currentItem = this.playlist.queue[this.playlist.currentIndex];

    // Handle blocked/unavailable videos specially
    if (errorInfo.type === 'blocked' && currentItem) {
      // Mark video as blocked in server history (removes it so it won't be auto-played again)
      await this.markVideoAsBlocked(currentItem.url, currentItem.embedId);

      // Don't increment consecutive errors for blocked videos - this is expected
      // Just skip to next track
      this.clearTrackTimer();
      this.stopCountdown();
      await this.handleTrackEnded();
      return;
    }

    // Regular error handling for non-blocked errors
    this.consecutiveErrors++;

    // Prevent infinite loops - max consecutive errors before stopping
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log.warn('Too many consecutive errors, stopping playback');
      this.consecutiveErrors = 0;
      this.playlist.isPlaying = false;
      this.renderUI();
      return;
    }

    // On error, remove the failed track and pick a new one (like trackEnded does)
    // This ensures the queue stays at 1 track for autoplay
    // Don't cycle through multiple tracks - that causes the rapid switching issue
    await this.handleTrackEnded();
  }

  private async markVideoAsBlocked(url: string, embedId?: string): Promise<void> {
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
      if (result.success) {
        // Successfully removed
      } else {
        log.warn('Failed to remove blocked video from history:', result.error);
      }
    } catch (error: unknown) {
      log.error('Error marking video as blocked:', error);
    }
  }

  // ============================================
  // PLAYER EVENT HANDLERS
  // ============================================

  private handlePlayerReady(): void {
    // Reset error counter on successful playback
    this.consecutiveErrors = 0;
  }

  private handleStateChange(state: string): void {
    // Track when playback actually started for stable play detection
    if (state === 'playing') {
      this.playbackStartedTime = Date.now();
      this.playlist.isPlaying = true;
      // Hide the loading overlay now that audio is actually playing
      this.hidePlaylistLoadingOverlay();
      // Update UI and enable emojis when video plays (including from player controls)
      this.renderUI();
      // Dispatch event for live-stream.js to sync button and enable emojis
      window.dispatchEvent(new CustomEvent('playlistStateChange', {
        detail: { state: 'playing', isPlaying: true }
      }));
    } else if (state === 'paused') {
      this.playlist.isPlaying = false;
      // Update UI when video pauses (including from player controls)
      this.renderUI();
      // Dispatch event for live-stream.js to sync button and disable emojis
      window.dispatchEvent(new CustomEvent('playlistStateChange', {
        detail: { state: 'paused', isPlaying: false }
      }));
    }
  }

  private handleTitleUpdate(title: string): void {
    const currentItem = this.playlist.queue[this.playlist.currentIndex];
    if (currentItem && isPlaceholderTitle(currentItem.title)) {
      currentItem.title = title;
      // Update the UI with the new title
      this.renderUI();
      // Note: Server history is updated with correct title when track ends (trackEnded action)
    }
  }

  // ============================================
  // LOAD FROM SERVER
  // ============================================

  private async loadFromServer(): Promise<void> {
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
        this.playlist = result.playlist;

        // If live stream is active, force playlist to not play
        if (window.isLiveStreamActive && this.playlist.isPlaying) {
          this.playlist.isPlaying = false;
        }

        // Check for stale or invalid playlist states
        let shouldClear = false;

        // Case 1: isPlaying is true but queue is empty
        if (this.playlist.isPlaying && this.playlist.queue.length === 0) {
          shouldClear = true;
        }

        // Case 2: isPlaying but no trackStartedAt (missing sync data)
        // NOTE: Do NOT set trackStartedAt here - let the server be the source of truth
        // If server doesn't have it, the track will play from the beginning which is safer
        if (this.playlist.isPlaying && this.playlist.queue.length > 0 && !this.playlist.trackStartedAt) {
          // intentionally empty - server is source of truth
        }

        // Case 3: trackStartedAt is more than 15 minutes old (track should have ended)
        if (this.playlist.isPlaying && this.playlist.trackStartedAt) {
          const startedAt = new Date(this.playlist.trackStartedAt).getTime();
          const now = Date.now();
          const elapsedMs = now - startedAt;
          const maxTrackMs = 15 * 60 * 1000; // 15 minutes max (buffer over 10 min limit)

          if (elapsedMs > maxTrackMs) {
            shouldClear = true;
          }
        }

        if (shouldClear) {
          await this.clearStalePlaylist();
        }
      }
    } catch (error: unknown) {
      log.error('Error loading from server:', error);
    }
  }

  private async clearStalePlaylist(): Promise<void> {
    try {
      // Reset to empty playlist
      this.playlist = {
        queue: [],
        currentIndex: 0,
        isPlaying: false,
        lastUpdated: new Date().toISOString(),
        trackStartedAt: undefined
      };

      // Sync empty state to server
      const staleController = new AbortController();
      const staleTimeoutId = setTimeout(() => staleController.abort(), TIMEOUTS.API_EXTENDED);

      await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          playlist: this.playlist
        }),
        signal: staleController.signal
      });
      clearTimeout(staleTimeoutId);

    } catch (error: unknown) {
      log.error('Error clearing stale playlist:', error);
    }
  }

  // ============================================
  // RENDER UI
  // ============================================

  private renderUI(): void {
    // Update reaction count display
    const reactionCount = this.playlist.reactionCount || 0;
    const likeCountEl = document.getElementById('likeCount');
    const fsLikes = document.getElementById('fsLikes');
    if (likeCountEl) likeCountEl.textContent = String(reactionCount);
    if (fsLikes) fsLikes.textContent = String(reactionCount);

    const event = new CustomEvent('playlistUpdate', {
      detail: {
        queue: this.playlist.queue,
        currentIndex: this.playlist.currentIndex,
        isPlaying: this.playlist.isPlaying,
        queueSize: this.playlist.queue.length,
        isAuthenticated: this.isAuthenticated,
        userId: this.userId,
        // Track timing for countdown sync
        trackStartedAt: this.playlist.trackStartedAt,
        // DJ Waitlist info
        userQueuePosition: this.getUserQueuePosition(),
        userTracksInQueue: this.getUserTracksInQueue(),
        isUsersTurn: this.isUsersTurn(),
        currentDj: this.getCurrentDj(),
        // Personal playlist
        personalPlaylist: this.getPersonalPlaylist(),
        // Global recently played (from Pusher)
        recentlyPlayed: this.globalRecentlyPlayed,
        // Reaction count
        reactionCount: reactionCount
      }
    });
    window.dispatchEvent(event);
  }

  // ============================================
  // UTILITY
  // ============================================

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  private async getAuthToken(): Promise<string | null> {
    try {
      const currentUser = window.firebaseAuth?.currentUser;
      return currentUser ? await currentUser.getIdToken() : null;
    } catch (_e: unknown) {
      /* intentional: auth token retrieval failure returns null -- unauthenticated fallback */
      return null;
    }
  }

  // ============================================
  // GETTERS
  // ============================================

  get queue(): GlobalPlaylistItem[] {
    return this.playlist.queue;
  }

  get currentIndex(): number {
    return this.playlist.currentIndex;
  }

  get isPlaying(): boolean {
    // If user has paused locally, report as not playing
    if (this.isPausedLocally) return false;
    return this.playlist.isPlaying;
  }

  get currentItem(): GlobalPlaylistItem | null {
    return this.playlist.queue[this.playlist.currentIndex] || null;
  }

  get authenticated(): boolean {
    return this.isAuthenticated;
  }

  get isActuallyPlaying(): boolean {
    return this.player?.isActuallyPlaying() ?? false;
  }

  setVolume(volume: number): void {
    this.player?.setVolume(volume);
  }

  getUserQueuePosition(): number | null {
    if (!this.userId) return null;
    const index = this.playlist.queue.findIndex(item => item.addedBy === this.userId);
    return index >= 0 ? index + 1 : null;
  }

  getUserTracksInQueue(): number {
    if (!this.userId) return 0;
    return this.playlist.queue.filter(item => item.addedBy === this.userId).length;
  }

  isUsersTurn(): boolean {
    if (!this.userId) return false;
    const currentItem = this.playlist.queue[0];
    return currentItem?.addedBy === this.userId;
  }

  getCurrentDj(): { userId: string; userName: string } | null {
    const currentItem = this.playlist.queue[0];
    if (!currentItem) return null;
    return {
      userId: currentItem.addedBy || '',
      userName: currentItem.addedByName || 'Anonymous'
    };
  }

  // ============================================
  // CLEANUP
  // ============================================

  destroy(): void {
    this.clearTrackTimer();
    this.stopCountdown();
    if (this.pusherChannel) {
      this.pusherChannel.unbind_all();
      const pusher = window.pusherInstance;
      if (pusher) {
        pusher.unsubscribe('live-playlist');
      }
    }
    stopPlaylistMeters();
    this.player?.destroy();
  }
}
