// src/lib/playlist-manager.ts
// Global playlist manager - synced across all viewers via Pusher

import type { GlobalPlaylistItem, GlobalPlaylist } from './types';
import { EmbedPlayerManager } from './embed-player';

const PLAYLIST_HISTORY_KEY = 'freshwax_playlist_history';
const RECENTLY_PLAYED_KEY = 'freshwax_recently_played';
const PERSONAL_PLAYLIST_KEY = 'freshwax_personal_playlist';
const MAX_HISTORY_SIZE = 100;
const MAX_PERSONAL_PLAYLIST_SIZE = 500; // Increased from 50
const TRACK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between same tracks
const MAX_TRACK_DURATION_MS = 10 * 60 * 1000; // 10 minutes max per track
const MAX_TRACK_DURATION_SECONDS = 10 * 60; // 10 minutes in seconds for validation

// History entry for offline playlist creation
interface PlaylistHistoryEntry {
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
interface PersonalPlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedAt: string;
}

export class PlaylistManager {
  private userId: string | null = null;
  private userName: string | null = null;
  private playlist: GlobalPlaylist;
  private player: EmbedPlayerManager;
  private isAuthenticated: boolean = false;
  public wasPausedForStream: boolean = false;
  private playHistory: PlaylistHistoryEntry[] = [];
  private personalPlaylist: PersonalPlaylistItem[] = []; // User's saved tracks
  private pusherChannel: any = null;
  private isSubscribed: boolean = false;
  private trackTimer: number | null = null; // Timer for max track duration
  private recentlyPlayed: Map<string, number> = new Map(); // URL -> timestamp
  private countdownInterval: number | null = null; // Countdown display interval
  private consecutiveErrors: number = 0; // Track errors to prevent infinite loops
  private containerId: string; // Store container ID for existence check
  private lastPlayedUrl: string | null = null; // Track last played URL to avoid immediate repeats
  private isPlayingLocked: boolean = false; // Prevent concurrent play operations
  private pendingPlayRequest: boolean = false; // Queue a play request if locked

  constructor(containerId: string) {
    this.containerId = containerId;
    this.playlist = {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString()
    };

    this.player = new EmbedPlayerManager(containerId, {
      onEnded: () => this.handleTrackEnded(),
      onError: (error) => this.handlePlaybackError(error),
      onReady: () => this.handlePlayerReady(),
      onStateChange: (state) => this.handleStateChange(state)
    });

    // Load play history, recently played, and personal playlist
    this.loadPlayHistory();
    this.loadRecentlyPlayed();
    this.loadPersonalPlaylist();
  }

  /**
   * Load recently played URLs from localStorage
   */
  private loadRecentlyPlayed(): void {
    try {
      const stored = localStorage.getItem(RECENTLY_PLAYED_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        const now = Date.now();
        // Only keep entries within cooldown period
        for (const [url, timestamp] of Object.entries(data)) {
          if (now - (timestamp as number) < TRACK_COOLDOWN_MS) {
            this.recentlyPlayed.set(url, timestamp as number);
          }
        }
        console.log('[PlaylistManager] Loaded recently played:', this.recentlyPlayed.size, 'tracks');
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading recently played:', error);
    }
  }

  /**
   * Save recently played URLs to localStorage
   */
  private saveRecentlyPlayed(): void {
    try {
      const data: Record<string, number> = {};
      const now = Date.now();
      // Only save entries within cooldown period
      for (const [url, timestamp] of this.recentlyPlayed.entries()) {
        if (now - timestamp < TRACK_COOLDOWN_MS) {
          data[url] = timestamp;
        }
      }
      localStorage.setItem(RECENTLY_PLAYED_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('[PlaylistManager] Error saving recently played:', error);
    }
  }

  /**
   * Check if a URL was played recently (within cooldown period)
   */
  private wasPlayedRecently(url: string): { recent: boolean; minutesRemaining?: number } {
    const timestamp = this.recentlyPlayed.get(url);
    if (!timestamp) return { recent: false };

    const elapsed = Date.now() - timestamp;
    if (elapsed >= TRACK_COOLDOWN_MS) {
      this.recentlyPlayed.delete(url);
      return { recent: false };
    }

    const minutesRemaining = Math.ceil((TRACK_COOLDOWN_MS - elapsed) / 60000);
    return { recent: true, minutesRemaining };
  }

  /**
   * Mark a URL as recently played
   */
  private markAsPlayed(url: string): void {
    this.lastPlayedUrl = url; // Track for immediate repeat prevention
    this.recentlyPlayed.set(url, Date.now());
    this.saveRecentlyPlayed();
  }

  /**
   * Start timer to auto-skip after max duration
   */
  private startTrackTimer(): void {
    this.clearTrackTimer();
    this.trackTimer = window.setTimeout(() => {
      console.log('[PlaylistManager] Track exceeded 10 minute limit, auto-skipping');
      this.handleTrackEnded();
    }, MAX_TRACK_DURATION_MS);
    console.log('[PlaylistManager] Track timer started (10 min limit)');
  }

  /**
   * Clear the track timer
   */
  private clearTrackTimer(): void {
    if (this.trackTimer) {
      clearTimeout(this.trackTimer);
      this.trackTimer = null;
    }
  }

  /**
   * Initialize playlist manager with global sync
   */
  async initialize(userId?: string, userName?: string): Promise<void> {
    this.userId = userId || null;
    this.userName = userName || null;
    this.isAuthenticated = !!userId;

    console.log('[PlaylistManager] Initializing, authenticated:', this.isAuthenticated);

    // Load global playlist from server
    await this.loadFromServer();

    // Load personal playlist from Firebase if authenticated
    if (this.isAuthenticated && this.userId) {
      await this.loadPersonalPlaylistFromServer();
    }

    // Subscribe to Pusher for real-time updates
    await this.subscribeToPusher();

    // If playlist is playing, start playback
    if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
      await this.playCurrent();
    }

    this.renderUI();
  }

  /**
   * Subscribe to Pusher for real-time playlist updates
   */
  private async subscribeToPusher(): Promise<void> {
    if (this.isSubscribed) return;

    // Wait for Pusher to be available
    const maxWait = 10000;
    const startTime = Date.now();

    while (!window.Pusher && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!window.Pusher) {
      console.warn('[PlaylistManager] Pusher not available, no real-time sync');
      return;
    }

    // Get Pusher config from window
    const pusherConfig = (window as any).PUSHER_CONFIG;
    if (!pusherConfig?.key) {
      console.warn('[PlaylistManager] Pusher config not found');
      return;
    }

    try {
      // Use existing Pusher instance if available, or create new one
      let pusher = (window as any).pusherInstance;
      if (!pusher) {
        pusher = new window.Pusher(pusherConfig.key, {
          cluster: pusherConfig.cluster || 'eu',
          forceTLS: true
        });
        (window as any).pusherInstance = pusher;
      }

      // Subscribe to playlist channel
      this.pusherChannel = pusher.subscribe('live-playlist');

      this.pusherChannel.bind('playlist-update', (data: GlobalPlaylist) => {
        console.log('[PlaylistManager] Received playlist update via Pusher');
        this.handleRemoteUpdate(data);
      });

      this.pusherChannel.bind('pusher:subscription_succeeded', () => {
        console.log('[PlaylistManager] Subscribed to live-playlist channel');
      });

      this.isSubscribed = true;
      console.log('[PlaylistManager] Pusher subscription active');
    } catch (error) {
      console.error('[PlaylistManager] Pusher subscription error:', error);
    }
  }

  /**
   * Handle remote playlist update from Pusher
   */
  private async handleRemoteUpdate(newPlaylist: GlobalPlaylist): Promise<void> {
    const wasPlaying = this.playlist.isPlaying;
    const oldCurrentItem = this.playlist.queue[this.playlist.currentIndex];
    const hadItems = this.playlist.queue.length > 0;

    // Update local playlist
    this.playlist = newPlaylist;

    const newCurrentItem = this.playlist.queue[this.playlist.currentIndex];
    const hasItems = this.playlist.queue.length > 0;

    // Case 1: Queue became empty (all tracks finished)
    if (hadItems && !hasItems) {
      console.log('[PlaylistManager] Queue is now empty, stopping playback');
      this.clearTrackTimer();
      this.stopCountdown();
      await this.player.destroy();
      this.disableEmojis();
      this.updateNowPlayingDisplay(null);
      this.showOfflineOverlay();
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
      await this.player.pause();
      this.disableEmojis();
    }
    // If just adding items to queue while playing, do nothing - let current track continue

    this.renderUI();
  }

  /**
   * Add item to global queue (requires authentication)
   */
  async addItem(url: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!url || !url.trim()) {
      return { success: false, error: 'Please enter a URL' };
    }

    if (!this.isAuthenticated || !this.userId) {
      return { success: false, error: 'Please sign in to add to playlist' };
    }

    // Check if URL was played recently (within 1 hour)
    const recentCheck = this.wasPlayedRecently(url.trim());
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
      // Parse URL locally first
      const { parseMediaUrl } = await import('./url-parser');
      const parsed = parseMediaUrl(url.trim());

      if (!parsed.isValid) {
        return { success: false, error: parsed.error || 'Invalid URL' };
      }

      // Fetch metadata for thumbnail/title
      const metadata = await this.fetchMetadata(url.trim());

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
      const response = await fetch('/api/playlist/global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item,
          userId: this.userId,
          userName: this.userName || 'Anonymous'
        })
      });

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
    } catch (error: any) {
      console.error('[PlaylistManager] Error adding item:', error);
      return { success: false, error: error.message || 'Failed to add to queue' };
    }
  }

  /**
   * Remove item from queue (only own items)
   */
  async removeItem(itemId: string): Promise<void> {
    if (!this.isAuthenticated || !this.userId) {
      console.warn('[PlaylistManager] Must be authenticated to remove items');
      return;
    }

    try {
      const response = await fetch('/api/playlist/global', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId,
          userId: this.userId
        })
      });

      const result = await response.json();

      if (!result.success) {
        console.error('[PlaylistManager] Remove failed:', result.error);
        return;
      }

      // Update local state
      if (result.playlist) {
        this.playlist = result.playlist;

        // If queue is empty, cleanup
        if (this.playlist.queue.length === 0) {
          await this.player.destroy();
          this.disableEmojis();
          this.updateNowPlayingDisplay(null);
          this.showOfflineOverlay();
        }
      }

      this.renderUI();
    } catch (error) {
      console.error('[PlaylistManager] Error removing item:', error);
    }
  }

  /**
   * Play playlist (viewer action - syncs to all)
   */
  async play(): Promise<void> {
    if (this.playlist.queue.length === 0) {
      console.warn('[PlaylistManager] Cannot play - queue is empty');
      return;
    }

    // Update server state
    await this.sendControlAction('play');
  }

  /**
   * Pause playlist (LOCAL ONLY - doesn't affect other users)
   */
  async pause(): Promise<void> {
    this.clearTrackTimer();
    this.stopCountdown();
    await this.player.pause();
    this.stopPlaylistMeters();
    this.disableEmojis();
    console.log('[PlaylistManager] Paused locally, meters stopped');
  }

  /**
   * Resume playback (LOCAL ONLY - syncs to current global position)
   */
  async resume(): Promise<void> {
    if (this.playlist.queue.length === 0) return;

    // Fetch latest playlist state to get current trackStartedAt
    try {
      const response = await fetch('/api/playlist/global');
      const result = await response.json();
      if (result.success && result.playlist) {
        this.playlist = result.playlist;
      }
    } catch (error) {
      console.warn('[PlaylistManager] Could not fetch latest state:', error);
    }

    // Resume and sync to current global position
    await this.player.play();
    this.enableEmojis();
    this.startPlaylistMeters();

    // Seek to current global position
    const syncPosition = this.calculateSyncPosition();
    if (syncPosition > 2) {
      console.log('[PlaylistManager] Resuming at position:', syncPosition, 'seconds');
      await this.player.seekTo(syncPosition);
    }

    // Restart countdown display
    this.updateDurationDisplay();

    console.log('[PlaylistManager] Resumed locally, meters started');
  }

  /**
   * Play next track
   */
  async playNext(): Promise<void> {
    if (this.playlist.queue.length === 0) return;
    await this.sendControlAction('next');
  }

  /**
   * Skip current track (admin only) - triggered by !skip command
   */
  async skipTrack(): Promise<void> {
    if (this.playlist.queue.length === 0) {
      console.warn('[PlaylistManager] Cannot skip - queue is empty');
      return;
    }
    console.log('[PlaylistManager] Admin skip triggered');
    await this.handleTrackEnded();
  }

  /**
   * Start auto-play from history when queue is empty and no live stream
   * Called by live-stream.js when going offline with empty queue
   */
  async startAutoPlay(): Promise<boolean> {
    // Don't start if already playing or queue has items
    if (this.playlist.isPlaying || this.playlist.queue.length > 0) {
      console.log('[PlaylistManager] Auto-play skipped - already playing or queue not empty');
      return false;
    }

    // Check if container exists
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.warn('[PlaylistManager] Auto-play skipped - player container not found');
      return false;
    }

    // Pick a random track from history
    const randomTrack = await this.pickRandomFromHistory();
    if (!randomTrack) {
      console.log('[PlaylistManager] Auto-play skipped - no tracks in history');
      return false;
    }

    // Add to queue and start playing
    this.playlist.queue.push(randomTrack);
    this.playlist.currentIndex = 0;
    this.playlist.isPlaying = true;
    this.playlist.trackStartedAt = new Date().toISOString();
    this.playlist.lastUpdated = new Date().toISOString();

    console.log('[PlaylistManager] Auto-play starting from history:', randomTrack.title || randomTrack.url);

    // Sync to server
    try {
      await fetch('/api/playlist/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          playlist: this.playlist
        })
      });
    } catch (error) {
      console.error('[PlaylistManager] Error syncing auto-play state:', error);
    }

    // Start playback
    await this.playCurrent();
    this.renderUI();

    return true;
  }

  /**
   * Send control action to server
   */
  private async sendControlAction(action: string): Promise<void> {
    try {
      const response = await fetch('/api/playlist/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          userId: this.userId
        })
      });

      const result = await response.json();

      if (result.success && result.playlist) {
        this.playlist = result.playlist;

        if (action === 'play' || action === 'next') {
          await this.playCurrent();
        } else if (action === 'pause') {
          await this.player.pause();
          this.disableEmojis();
        }

        this.renderUI();
      }
    } catch (error) {
      console.error('[PlaylistManager] Control action error:', error);
    }
  }

  /**
   * Clear entire queue (admin only in future)
   */
  async clearQueue(): Promise<void> {
    // For now, just clear locally
    this.playlist.queue = [];
    this.playlist.currentIndex = 0;
    this.playlist.isPlaying = false;

    await this.player.destroy();
    this.disableEmojis();
    this.updateNowPlayingDisplay(null);
    this.showOfflineOverlay();
    this.renderUI();
  }

  /**
   * Calculate sync position based on trackStartedAt timestamp
   */
  private calculateSyncPosition(): number {
    console.log('[PlaylistManager] calculateSyncPosition called, trackStartedAt:', this.playlist.trackStartedAt);
    if (!this.playlist.trackStartedAt) {
      console.log('[PlaylistManager] No trackStartedAt, returning 0');
      return 0;
    }

    const startedAt = new Date(this.playlist.trackStartedAt).getTime();
    const now = Date.now();
    const elapsedSeconds = Math.floor((now - startedAt) / 1000);
    console.log('[PlaylistManager] Calculated elapsed time:', elapsedSeconds, 'seconds');

    // Cap at 10 minutes (max track duration)
    const maxSeconds = MAX_TRACK_DURATION_MS / 1000;
    return Math.min(Math.max(0, elapsedSeconds), maxSeconds);
  }

  /**
   * Play current track (with lock to prevent race conditions)
   */
  private async playCurrent(): Promise<void> {
    const currentItem = this.playlist.queue[this.playlist.currentIndex];
    if (!currentItem) return;

    // Check if container exists before trying to play
    // (prevents errors when playlist manager exists but player isn't on page)
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.warn('[PlaylistManager] Player container not found - skipping playback');
      return;
    }

    // Prevent concurrent play operations (race condition fix)
    if (this.isPlayingLocked) {
      console.log('[PlaylistManager] Play already in progress, queuing request');
      this.pendingPlayRequest = true;
      return;
    }

    this.isPlayingLocked = true;
    this.pendingPlayRequest = false;

    try {
      // Show video player and hide overlays
      this.showVideoPlayer();

      // Log to play history (local and server)
      this.logToHistory(currentItem);
      this.logToServerHistory(currentItem);

      // Mark URL as played (for 1-hour cooldown)
      this.markAsPlayed(currentItem.url);

      // Start 10-minute timer
      this.startTrackTimer();

      // Enable emoji reactions
      this.enableEmojis();

      // Update NOW PLAYING display
      this.updateNowPlayingDisplay(currentItem);

      // Calculate sync position BEFORE loading the item
      const syncPosition = this.calculateSyncPosition();
      if (syncPosition > 2) { // Only seek if more than 2 seconds in
        console.log('[PlaylistManager] Setting pending seek to:', syncPosition, 'seconds');
        this.player.setPendingSeek(syncPosition);
      }

      await this.player.loadItem(currentItem);

      this.renderUI();

      console.log('[PlaylistManager] Now playing:', currentItem.title || currentItem.url);
    } catch (error) {
      console.error('[PlaylistManager] Error playing current:', error);
      // Try next track
      await this.playNext();
    } finally {
      this.isPlayingLocked = false;

      // If there was a pending play request, execute it
      if (this.pendingPlayRequest) {
        console.log('[PlaylistManager] Executing pending play request');
        this.pendingPlayRequest = false;
        // Use setTimeout to avoid stack overflow
        setTimeout(() => this.playCurrent(), 50);
      }
    }
  }

  /**
   * Log item to play history for offline playlist creation
   * Prevents duplicate URLs - each URL only appears once in history
   */
  private logToHistory(item: GlobalPlaylistItem): void {
    // Check if URL already exists in history - no duplicates allowed
    const existingIndex = this.playHistory.findIndex(entry => entry.url === item.url);
    if (existingIndex >= 0) {
      // URL already in history - update playedAt timestamp and move to front
      const existing = this.playHistory.splice(existingIndex, 1)[0];
      existing.playedAt = new Date().toISOString();
      // Update other fields in case they've changed
      existing.title = item.title || existing.title;
      existing.thumbnail = item.thumbnail || existing.thumbnail;
      this.playHistory.unshift(existing);
      this.savePlayHistory();
      console.log('[PlaylistManager] URL already in history, moved to front:', existing.title || existing.url);
      return;
    }

    const historyEntry: PlaylistHistoryEntry = {
      id: item.id,
      url: item.url,
      platform: item.platform,
      embedId: item.embedId,
      title: item.title,
      thumbnail: item.thumbnail,
      playedAt: new Date().toISOString()
    };

    // Add to beginning of history
    this.playHistory.unshift(historyEntry);

    // Trim to max size
    if (this.playHistory.length > MAX_HISTORY_SIZE) {
      this.playHistory = this.playHistory.slice(0, MAX_HISTORY_SIZE);
    }

    // Save to localStorage
    this.savePlayHistory();

    console.log('[PlaylistManager] Logged to history:', historyEntry.title || historyEntry.url);
  }

  /**
   * Log item to server-side master history (for auto-play across all users)
   */
  private async logToServerHistory(item: GlobalPlaylistItem): Promise<void> {
    try {
      await fetch('/api/playlist/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: {
            id: item.id,
            url: item.url,
            platform: item.platform,
            embedId: item.embedId,
            title: item.title,
            thumbnail: item.thumbnail,
            addedBy: item.addedBy,
            addedByName: item.addedByName
          }
        })
      });
      console.log('[PlaylistManager] Logged to server history');
    } catch (error) {
      console.error('[PlaylistManager] Error logging to server history:', error);
    }
  }

  /**
   * Enable emoji reactions, audio meters, and chat
   */
  private enableEmojis(): void {
    (window as any).emojiAnimationsEnabled = true;

    const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
    reactionButtons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = false;
      btn.classList.remove('disabled', 'reactions-disabled');
    });

    // Hide "Sign in to chat" prompt and show chat input
    const loginPrompt = document.getElementById('loginPrompt');
    if (loginPrompt) {
      loginPrompt.style.display = 'none';
    }

    // Enable chat for playlist mode
    if (typeof (window as any).setChatEnabled === 'function') {
      (window as any).setChatEnabled(true);
    }

    // Setup chat channel for playlist mode if not already done
    if (typeof (window as any).setupChat === 'function' && !(window as any).playlistChatSetup) {
      (window as any).setupChat('playlist-global');
      (window as any).playlistChatSetup = true;
      console.log('[PlaylistManager] Chat enabled for playlist mode');
    }

    // Hide the main stereo meters and toggle button when playlist is playing
    const stereoMeters = document.getElementById('stereoMeters');
    const toggleMetersBtn = document.getElementById('toggleMetersBtn');
    if (stereoMeters) {
      stereoMeters.style.display = 'none';
    }
    if (toggleMetersBtn) {
      toggleMetersBtn.style.display = 'none';
    }

    this.startPlaylistMeters();
    console.log('[PlaylistManager] Emoji reactions, chat, and playlist meters enabled (main meters hidden)');
  }

  /**
   * Disable emoji reactions, audio meters, and chat (only if no live stream active)
   */
  private disableEmojis(): void {
    (window as any).emojiAnimationsEnabled = false;

    const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
    reactionButtons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = true;
      btn.classList.add('disabled', 'reactions-disabled');
    });

    // Only disable chat if no live stream is active
    const isLiveStreamActive = (window as any).isLiveStreamActive;
    if (!isLiveStreamActive) {
      if (typeof (window as any).setChatEnabled === 'function') {
        (window as any).setChatEnabled(false);
      }

      // Reset playlist chat setup flag
      (window as any).playlistChatSetup = false;
      console.log('[PlaylistManager] Chat disabled (no active stream or playlist)');
    }

    this.stopPlaylistMeters();

    // Show the main stereo meters and toggle button again when playlist stops
    const stereoMeters = document.getElementById('stereoMeters');
    const toggleMetersBtn = document.getElementById('toggleMetersBtn');
    if (stereoMeters) {
      stereoMeters.style.display = '';
    }
    if (toggleMetersBtn) {
      toggleMetersBtn.style.display = '';
    }
  }

  private playlistMeterAnimationId: number | null = null;
  private meterState = {
    leftLevel: 0,
    rightLevel: 0,
    targetLeft: 0,
    targetRight: 0,
    beatPhase: 0,
    lastBeatTime: 0,
    bpm: 140 + Math.random() * 40, // Random BPM between 140-180 for D&B feel
  };

  /**
   * Start simulated audio meters for playlist playback
   * Uses realistic decay, beat sync, and correlated stereo
   */
  private startPlaylistMeters(): void {
    if (this.playlistMeterAnimationId) return;

    const leftLeds = document.querySelectorAll('#leftMeter .led');
    const rightLeds = document.querySelectorAll('#rightMeter .led');

    if (leftLeds.length === 0 || rightLeds.length === 0) return;

    // Reset state
    this.meterState.leftLevel = 0;
    this.meterState.rightLevel = 0;
    this.meterState.lastBeatTime = performance.now();
    this.meterState.bpm = 140 + Math.random() * 40;

    const updateMeters = () => {
      // Check if animation was cancelled (paused)
      if (!this.playlistMeterAnimationId) {
        return;
      }

      const now = performance.now();
      const beatInterval = 60000 / this.meterState.bpm; // ms per beat
      const timeSinceBeat = now - this.meterState.lastBeatTime;

      // Check for beat hit
      if (timeSinceBeat >= beatInterval) {
        this.meterState.lastBeatTime = now;
        // Strong beat - push levels up
        const beatStrength = 0.7 + Math.random() * 0.3;
        this.meterState.targetLeft = 8 + Math.random() * 6 * beatStrength;
        this.meterState.targetRight = 8 + Math.random() * 6 * beatStrength;

        // Occasional big peak (like a drop or snare hit)
        if (Math.random() < 0.15) {
          this.meterState.targetLeft = Math.min(14, this.meterState.targetLeft + 3);
          this.meterState.targetRight = Math.min(14, this.meterState.targetRight + 3);
        }
      } else {
        // Between beats - decay with some variation
        const decayProgress = timeSinceBeat / beatInterval;
        const decay = 0.92 - decayProgress * 0.15; // Faster decay as we approach next beat

        this.meterState.targetLeft *= decay;
        this.meterState.targetRight *= decay;

        // Add subtle random movement (hi-hats, cymbals)
        if (Math.random() < 0.3) {
          this.meterState.targetLeft += Math.random() * 2;
          this.meterState.targetRight += Math.random() * 2;
        }
      }

      // Smooth interpolation toward target (attack/release)
      const attackSpeed = 0.4;
      const releaseSpeed = 0.15;

      if (this.meterState.targetLeft > this.meterState.leftLevel) {
        this.meterState.leftLevel += (this.meterState.targetLeft - this.meterState.leftLevel) * attackSpeed;
      } else {
        this.meterState.leftLevel += (this.meterState.targetLeft - this.meterState.leftLevel) * releaseSpeed;
      }

      if (this.meterState.targetRight > this.meterState.rightLevel) {
        this.meterState.rightLevel += (this.meterState.targetRight - this.meterState.rightLevel) * attackSpeed;
      } else {
        this.meterState.rightLevel += (this.meterState.targetRight - this.meterState.rightLevel) * releaseSpeed;
      }

      // Add slight stereo difference for realism
      const stereoOffset = (Math.random() - 0.5) * 1.5;
      const leftDisplay = Math.floor(Math.max(0, Math.min(14, this.meterState.leftLevel + stereoOffset)));
      const rightDisplay = Math.floor(Math.max(0, Math.min(14, this.meterState.rightLevel - stereoOffset)));

      // Update LED display
      leftLeds.forEach((led, i) => led.classList.toggle('active', i < leftDisplay));
      rightLeds.forEach((led, i) => led.classList.toggle('active', i < rightDisplay));

      this.playlistMeterAnimationId = requestAnimationFrame(updateMeters);
    };

    this.playlistMeterAnimationId = requestAnimationFrame(updateMeters);
    console.log('[PlaylistManager] Audio meters started (BPM:', Math.round(this.meterState.bpm), ')');
  }

  /**
   * Stop simulated audio meters
   */
  private stopPlaylistMeters(): void {
    if (this.playlistMeterAnimationId) {
      cancelAnimationFrame(this.playlistMeterAnimationId);
      this.playlistMeterAnimationId = null;
    }

    // Smooth fade out
    const leftLeds = document.querySelectorAll('#leftMeter .led');
    const rightLeds = document.querySelectorAll('#rightMeter .led');

    leftLeds.forEach(led => led.classList.remove('active'));
    rightLeds.forEach(led => led.classList.remove('active'));

    // Reset state
    this.meterState.leftLevel = 0;
    this.meterState.rightLevel = 0;

    console.log('[PlaylistManager] Audio meters stopped');
  }

  /**
   * Format seconds as MM:SS or H:MM:SS
   */
  private formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '--:--';

    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Update NOW PLAYING display at bottom of screen
   */
  private updateNowPlayingDisplay(item: GlobalPlaylistItem | null): void {
    const djNameEl = document.getElementById('controlsDjName');
    const djAvatarEl = document.getElementById('djAvatar') as HTMLImageElement;
    const genreEl = document.getElementById('streamGenre');
    const labelEl = document.querySelector('.dj-info-label');
    const djInfoBar = document.querySelector('.dj-info-bar');

    if (item) {
      // Add playlist mode class for red text styling
      if (djInfoBar) {
        djInfoBar.classList.add('playlist-mode');
      }
      if (djNameEl) {
        djNameEl.textContent = item.title || 'Untitled Video';
      }
      if (labelEl) {
        labelEl.textContent = 'PLAYLIST';
      }
      if (djAvatarEl && item.thumbnail) {
        djAvatarEl.src = item.thumbnail;
      }
      if (genreEl) {
        // Show loading initially, then update with duration
        genreEl.textContent = '--:--';
        // Fetch duration after player is ready
        this.updateDurationDisplay();
      }
    } else {
      // Remove playlist mode class
      if (djInfoBar) {
        djInfoBar.classList.remove('playlist-mode');
      }
      if (djNameEl) {
        djNameEl.textContent = '--';
      }
      if (labelEl) {
        labelEl.textContent = 'NOW PLAYING';
      }
      if (djAvatarEl) {
        djAvatarEl.src = '/place-holder.webp';
      }
      if (genreEl) {
        genreEl.textContent = 'Jungle / D&B';
      }
    }
  }

  /**
   * Update duration display after player is ready - shows countdown
   */
  private async updateDurationDisplay(): Promise<void> {
    const genreEl = document.getElementById('streamGenre');
    if (!genreEl) return;

    // Clear any existing countdown
    this.stopCountdown();

    // Wait a moment for player to be ready and have duration info
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
      const duration = await this.player.getDuration();
      if (duration > 0) {
        // Start countdown interval
        this.startCountdown(duration);
      }
    } catch (error) {
      console.warn('[PlaylistManager] Could not get duration:', error);
    }
  }

  /**
   * Start countdown display that updates every second
   */
  private async startCountdown(totalDuration: number): Promise<void> {
    const genreEl = document.getElementById('streamGenre');
    if (!genreEl) return;

    // Update display immediately
    const updateDisplay = async () => {
      try {
        const currentTime = await this.player.getCurrentTime();
        const remaining = Math.max(0, totalDuration - currentTime);
        genreEl.textContent = this.formatDuration(remaining);
      } catch (error) {
        // Silently fail if player not ready
      }
    };

    await updateDisplay();

    // Update every second
    this.countdownInterval = window.setInterval(updateDisplay, 1000);
  }

  /**
   * Stop countdown display
   */
  private stopCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /**
   * Load play history from localStorage
   */
  private loadPlayHistory(): void {
    try {
      const stored = localStorage.getItem(PLAYLIST_HISTORY_KEY);
      if (stored) {
        this.playHistory = JSON.parse(stored);
        console.log('[PlaylistManager] Loaded play history:', this.playHistory.length, 'items');
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading play history:', error);
      this.playHistory = [];
    }
  }

  /**
   * Save play history to localStorage
   */
  private savePlayHistory(): void {
    try {
      localStorage.setItem(PLAYLIST_HISTORY_KEY, JSON.stringify(this.playHistory));
    } catch (error) {
      console.error('[PlaylistManager] Error saving play history:', error);
    }
  }

  /**
   * Get play history for offline playlist creation
   */
  getPlayHistory(): PlaylistHistoryEntry[] {
    return [...this.playHistory];
  }

  /**
   * Pick a random track from history that hasn't been played recently
   * Used for auto-play when queue is empty
   * Always uses server-side master history (8,273 videos) for maximum variety
   * Uses 60-minute cooldown and never repeats the last played track
   */
  private async pickRandomFromHistory(): Promise<GlobalPlaylistItem | null> {
    // Always fetch from server-side master history for maximum variety
    console.log('[PlaylistManager] Fetching from server history for auto-play');
    try {
      const response = await fetch('/api/playlist/history');
      const result = await response.json();
      if (result.success && result.items && result.items.length > 0) {
        const serverHistory = result.items;
        console.log('[PlaylistManager] Server has', serverHistory.length, 'tracks available');

        // Filter out recently played tracks and the last played track
        const AUTO_PLAY_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
        const now = Date.now();

        const availableTracks = serverHistory.filter((entry: any) => {
          // Never pick the track that just finished playing
          if (entry.url === this.lastPlayedUrl) return false;

          const timestamp = this.recentlyPlayed.get(entry.url);
          if (!timestamp) return true; // Never played recently, available
          const elapsed = now - timestamp;
          return elapsed >= AUTO_PLAY_COOLDOWN_MS; // Available if 60+ minutes since last play
        });

        console.log('[PlaylistManager]', availableTracks.length, 'tracks available after cooldown filter');

        if (availableTracks.length === 0) {
          // All tracks on cooldown - just pick a random one that isn't the last played
          const fallbackTracks = serverHistory.filter((entry: any) => entry.url !== this.lastPlayedUrl);
          if (fallbackTracks.length > 0) {
            const randomIndex = Math.floor(Math.random() * fallbackTracks.length);
            const selected = fallbackTracks[randomIndex];
            console.log('[PlaylistManager] All on cooldown, picked random:', selected.title || selected.url);

            // Fetch real title if placeholder
            let title = selected.title;
            if (this.isPlaceholderTitle(title) && selected.embedId) {
              const realTitle = await this.fetchYouTubeTitle(selected.embedId);
              if (realTitle) title = realTitle;
            }

            return {
              id: this.generateId(),
              url: selected.url,
              platform: selected.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
              embedId: selected.embedId,
              title: title,
              thumbnail: selected.thumbnail,
              addedAt: new Date().toISOString(),
              addedBy: 'system',
              addedByName: 'Auto-Play'
            };
          }
        }

        // Pick a random track from available tracks
        const randomIndex = Math.floor(Math.random() * availableTracks.length);
        const selected = availableTracks[randomIndex];

        console.log('[PlaylistManager] Selected random track:', selected.title || selected.url);

        // Fetch real title if it's a placeholder (e.g., "Track 1234")
        let title = selected.title;
        if (this.isPlaceholderTitle(title) && selected.embedId) {
          const realTitle = await this.fetchYouTubeTitle(selected.embedId);
          if (realTitle) {
            title = realTitle;
            console.log('[PlaylistManager] Fetched real title:', title);
          }
        }

        return {
          id: this.generateId(),
          url: selected.url,
          platform: selected.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
          embedId: selected.embedId,
          title: title,
          thumbnail: selected.thumbnail,
          addedAt: new Date().toISOString(),
          addedBy: 'system',
          addedByName: 'Auto-Play'
        };
      }
    } catch (error) {
      console.error('[PlaylistManager] Error fetching server history:', error);
    }

    // Fallback to local history if server fails
    if (this.playHistory.length > 0) {
      console.log('[PlaylistManager] Server failed, using local history:', this.playHistory.length, 'tracks');
      const randomIndex = Math.floor(Math.random() * this.playHistory.length);
      const selected = this.playHistory[randomIndex];

      // Fetch real title if it's a placeholder
      let title = selected.title;
      if (this.isPlaceholderTitle(title) && selected.embedId) {
        const realTitle = await this.fetchYouTubeTitle(selected.embedId);
        if (realTitle) title = realTitle;
      }

      return {
        id: this.generateId(),
        url: selected.url,
        platform: selected.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
        embedId: selected.embedId,
        title: title,
        thumbnail: selected.thumbnail,
        addedAt: new Date().toISOString(),
        addedBy: 'system',
        addedByName: 'Auto-Play'
      };
    }

    console.log('[PlaylistManager] No tracks available for auto-play');
    return null;
  }

  /**
   * Clear play history
   */
  clearPlayHistory(): void {
    this.playHistory = [];
    this.savePlayHistory();
    console.log('[PlaylistManager] Play history cleared');
  }

  // ============================================
  // PERSONAL PLAYLIST METHODS
  // ============================================

  /**
   * Load personal playlist from localStorage (initial/fallback)
   */
  private loadPersonalPlaylist(): void {
    try {
      const stored = localStorage.getItem(PERSONAL_PLAYLIST_KEY);
      if (stored) {
        this.personalPlaylist = JSON.parse(stored);
        console.log('[PlaylistManager] Loaded personal playlist from localStorage:', this.personalPlaylist.length, 'items');
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading personal playlist:', error);
      this.personalPlaylist = [];
    }
  }

  /**
   * Load personal playlist from Firebase (called when user authenticates)
   */
  async loadPersonalPlaylistFromServer(): Promise<void> {
    if (!this.userId) {
      console.log('[PlaylistManager] No userId, skipping Firebase playlist load');
      return;
    }

    try {
      const response = await fetch(`/api/playlist/personal?userId=${encodeURIComponent(this.userId)}`);
      const result = await response.json();

      if (result.success && Array.isArray(result.playlist)) {
        // Merge with localStorage (Firebase takes priority for duplicates)
        const firebaseItems = result.playlist;
        const localItems = this.personalPlaylist;

        // Create a map of existing URLs from Firebase
        const firebaseUrls = new Set(firebaseItems.map((item: any) => item.url));

        // Add local items that aren't in Firebase
        const mergedItems = [...firebaseItems];
        for (const localItem of localItems) {
          if (!firebaseUrls.has(localItem.url)) {
            mergedItems.push(localItem);
          }
        }

        this.personalPlaylist = mergedItems;
        console.log('[PlaylistManager] Loaded personal playlist from Firebase:', firebaseItems.length, 'items, merged total:', mergedItems.length);

        // Save merged list back to both localStorage and Firebase
        this.savePersonalPlaylist();
        this.savePersonalPlaylistToServer();
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading personal playlist from Firebase:', error);
      // Keep using localStorage data
    }
  }

  /**
   * Save personal playlist to localStorage
   */
  private savePersonalPlaylist(): void {
    try {
      localStorage.setItem(PERSONAL_PLAYLIST_KEY, JSON.stringify(this.personalPlaylist));
    } catch (error) {
      console.error('[PlaylistManager] Error saving personal playlist to localStorage:', error);
    }
  }

  /**
   * Save personal playlist to Firebase (async, non-blocking)
   */
  private async savePersonalPlaylistToServer(): Promise<void> {
    if (!this.userId) return;

    try {
      await fetch('/api/playlist/personal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.userId,
          items: this.personalPlaylist
        })
      });
      console.log('[PlaylistManager] Personal playlist saved to Firebase');
    } catch (error) {
      console.error('[PlaylistManager] Error saving personal playlist to Firebase:', error);
    }
  }

  /**
   * Add a track to personal playlist (for later use)
   */
  async addToPersonalPlaylist(url: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!url || !url.trim()) {
      return { success: false, error: 'Please enter a URL' };
    }

    // Check if already in personal playlist
    const alreadyInPlaylist = this.personalPlaylist.some(item => item.url === url.trim());
    if (alreadyInPlaylist) {
      return { success: false, error: 'This track is already in your playlist' };
    }

    // Check max size
    if (this.personalPlaylist.length >= MAX_PERSONAL_PLAYLIST_SIZE) {
      return { success: false, error: `Personal playlist is full (${MAX_PERSONAL_PLAYLIST_SIZE} items max)` };
    }

    try {
      // Parse URL
      const { parseMediaUrl } = await import('./url-parser');
      const parsed = parseMediaUrl(url.trim());

      if (!parsed.isValid) {
        return { success: false, error: parsed.error || 'Invalid URL' };
      }

      // Fetch metadata
      const metadata = await this.fetchMetadata(url.trim());

      // Get thumbnail
      let thumbnail = metadata.thumbnail;
      if (!thumbnail && parsed.platform === 'youtube' && parsed.embedId) {
        thumbnail = `https://img.youtube.com/vi/${parsed.embedId}/mqdefault.jpg`;
      }

      const item: PersonalPlaylistItem = {
        id: this.generateId(),
        url: url.trim(),
        platform: parsed.platform,
        embedId: parsed.embedId,
        title: metadata.title,
        thumbnail,
        addedAt: new Date().toISOString()
      };

      this.personalPlaylist.push(item);
      this.savePersonalPlaylist();
      this.savePersonalPlaylistToServer(); // Save to Firebase for persistence
      this.renderUI();

      console.log('[PlaylistManager] Added to personal playlist:', item.title || item.url);
      return { success: true, message: 'Added to your playlist' };
    } catch (error: any) {
      console.error('[PlaylistManager] Error adding to personal playlist:', error);
      return { success: false, error: error.message || 'Failed to add to playlist' };
    }
  }

  /**
   * Remove a track from personal playlist
   */
  removeFromPersonalPlaylist(itemId: string): void {
    const index = this.personalPlaylist.findIndex(item => item.id === itemId);
    if (index >= 0) {
      const removed = this.personalPlaylist.splice(index, 1)[0];
      this.savePersonalPlaylist();
      this.savePersonalPlaylistToServer(); // Save to Firebase for persistence
      this.renderUI();
      console.log('[PlaylistManager] Removed from personal playlist:', removed.title || removed.url);
    }
  }

  /**
   * Add a track from personal playlist to the main DJ queue
   */
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

  /**
   * Get personal playlist items
   */
  getPersonalPlaylist(): PersonalPlaylistItem[] {
    return [...this.personalPlaylist];
  }

  /**
   * Clear personal playlist
   */
  clearPersonalPlaylist(): void {
    this.personalPlaylist = [];
    this.savePersonalPlaylist();
    this.savePersonalPlaylistToServer(); // Save to Firebase for persistence
    this.renderUI();
    console.log('[PlaylistManager] Personal playlist cleared');
  }

  /**
   * Show video player and hide overlays
   */
  private showVideoPlayer(): void {
    const offlineOverlay = document.getElementById('offlineOverlay');
    const audioPlayer = document.getElementById('audioPlayer');
    const videoPlayer = document.getElementById('videoPlayer');
    const playlistPlayer = document.getElementById('playlistPlayer');
    const hlsVideo = document.getElementById('hlsVideoElement');

    if (offlineOverlay) {
      offlineOverlay.classList.add('hidden');
      offlineOverlay.style.display = 'none';
    }
    if (audioPlayer) {
      audioPlayer.classList.add('hidden');
    }
    if (hlsVideo) {
      hlsVideo.classList.add('hidden');
    }

    if (videoPlayer) {
      videoPlayer.classList.remove('hidden');
      videoPlayer.style.display = 'block';
      videoPlayer.style.opacity = '1';
    }
    if (playlistPlayer) {
      playlistPlayer.classList.remove('hidden');
      playlistPlayer.style.display = 'block';
    }

    console.log('[PlaylistManager] Video player shown, overlays hidden');
  }

  /**
   * Show offline overlay
   */
  private showOfflineOverlay(): void {
    const offlineOverlay = document.getElementById('offlineOverlay');
    const videoPlayer = document.getElementById('videoPlayer');

    if (offlineOverlay) {
      offlineOverlay.classList.remove('hidden');
      offlineOverlay.style.display = '';
    }
    if (videoPlayer) {
      videoPlayer.classList.add('hidden');
    }
  }

  /**
   * Handle track ended - remove finished track and play next
   */
  private async handleTrackEnded(): Promise<void> {
    // Clear timers first
    this.clearTrackTimer();
    this.stopCountdown();

    console.log('[PlaylistManager] Track ended, removing and playing next');

    const finishedItem = this.playlist.queue[this.playlist.currentIndex];
    if (!finishedItem) {
      console.log('[PlaylistManager] No item to remove');
      return;
    }

    // Remove the finished item from queue
    this.playlist.queue.splice(this.playlist.currentIndex, 1);

    // Adjust currentIndex to stay in bounds
    const now = new Date().toISOString();
    if (this.playlist.queue.length === 0) {
      // Queue is empty - try to auto-play a random track from history
      const randomTrack = await this.pickRandomFromHistory();
      if (randomTrack) {
        // Add the random track to queue and continue playing
        this.playlist.queue.push(randomTrack);
        this.playlist.currentIndex = 0;
        this.playlist.isPlaying = true;
        this.playlist.trackStartedAt = now;
        console.log('[PlaylistManager] Queue empty - auto-playing from history:', randomTrack.title || randomTrack.url);
      } else {
        // No tracks available from history - stop playback
        this.playlist.currentIndex = 0;
        this.playlist.isPlaying = false;
        this.playlist.trackStartedAt = null; // Clear track start time
        await this.player.destroy();
        this.disableEmojis();
        this.updateNowPlayingDisplay(null);
        this.showOfflineOverlay();
      }
    } else {
      // Keep currentIndex in bounds (it now points to the next item)
      if (this.playlist.currentIndex >= this.playlist.queue.length) {
        this.playlist.currentIndex = 0; // Wrap to start
      }
      // Reset trackStartedAt for the new track - this is critical for sync!
      this.playlist.trackStartedAt = now;
    }

    this.playlist.lastUpdated = now;

    // Sync to server
    try {
      await fetch('/api/playlist/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          playlist: this.playlist
        })
      });
    } catch (error) {
      console.error('[PlaylistManager] Error syncing after track ended:', error);
    }

    // Play next if queue not empty
    if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
      await this.playCurrent();
    }

    this.renderUI();
  }

  /**
   * Handle playback error
   */
  private async handlePlaybackError(error: string): Promise<void> {
    console.error('[PlaylistManager] Playback error:', error);

    // Increment consecutive error counter
    this.consecutiveErrors++;

    // Check if container exists - if not, stop trying
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.warn('[PlaylistManager] Container not found - player may not be on this page. Stopping playback attempts.');
      this.consecutiveErrors = 0;
      return;
    }

    // Prevent infinite loops - max 3 consecutive errors
    if (this.consecutiveErrors >= 3) {
      console.warn('[PlaylistManager] Too many consecutive errors, stopping playback');
      this.consecutiveErrors = 0;
      this.playlist.isPlaying = false;
      this.renderUI();
      return;
    }

    if (this.playlist.queue.length > 1) {
      await this.playNext();
    } else {
      this.playlist.isPlaying = false;
      this.renderUI();
    }
  }

  /**
   * Handle player ready
   */
  private handlePlayerReady(): void {
    console.log('[PlaylistManager] Player ready');
    // Reset error counter on successful playback
    this.consecutiveErrors = 0;
  }

  /**
   * Handle state change
   */
  private handleStateChange(state: string): void {
    console.log('[PlaylistManager] State changed:', state);
    // Reset error counter on successful state changes
    if (state === 'playing') {
      this.consecutiveErrors = 0;
    }
  }

  /**
   * Load playlist from server
   */
  private async loadFromServer(): Promise<void> {
    try {
      const response = await fetch('/api/playlist/global');
      const result = await response.json();

      if (result.success && result.playlist) {
        this.playlist = result.playlist;
        console.log('[PlaylistManager] Loaded global playlist:', this.playlist.queue.length, 'items, trackStartedAt:', this.playlist.trackStartedAt, 'isPlaying:', this.playlist.isPlaying);

        // Check for stale or invalid playlist states
        let shouldClear = false;

        // Case 1: isPlaying is true but queue is empty
        if (this.playlist.isPlaying && this.playlist.queue.length === 0) {
          console.log('[PlaylistManager] isPlaying but queue is empty - clearing stale state');
          shouldClear = true;
        }

        // Case 2: isPlaying but no trackStartedAt (missing sync data)
        // NOTE: Do NOT set trackStartedAt here - let the server be the source of truth
        // If server doesn't have it, the track will play from the beginning which is safer
        if (this.playlist.isPlaying && this.playlist.queue.length > 0 && !this.playlist.trackStartedAt) {
          console.log('[PlaylistManager] isPlaying but no trackStartedAt from server - sync may not work');
        }

        // Case 3: trackStartedAt is more than 15 minutes old (track should have ended)
        if (this.playlist.isPlaying && this.playlist.trackStartedAt) {
          const startedAt = new Date(this.playlist.trackStartedAt).getTime();
          const now = Date.now();
          const elapsedMs = now - startedAt;
          const maxTrackMs = 15 * 60 * 1000; // 15 minutes max (buffer over 10 min limit)

          if (elapsedMs > maxTrackMs) {
            console.log('[PlaylistManager] Track has been playing for too long - clearing stale data');
            shouldClear = true;
          }
        }

        if (shouldClear) {
          await this.clearStalePlaylist();
        }
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading from server:', error);
    }
  }

  /**
   * Clear stale playlist data from server
   */
  private async clearStalePlaylist(): Promise<void> {
    try {
      // Reset to empty playlist
      this.playlist = {
        queue: [],
        currentIndex: 0,
        isPlaying: false,
        lastUpdated: new Date().toISOString(),
        trackStartedAt: null
      };

      // Sync empty state to server
      await fetch('/api/playlist/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          playlist: this.playlist
        })
      });

      console.log('[PlaylistManager] Cleared stale playlist');
    } catch (error) {
      console.error('[PlaylistManager] Error clearing stale playlist:', error);
    }
  }

  /**
   * Render UI (dispatch event for components to update)
   */
  private renderUI(): void {
    const event = new CustomEvent('playlistUpdate', {
      detail: {
        queue: this.playlist.queue,
        currentIndex: this.playlist.currentIndex,
        isPlaying: this.playlist.isPlaying,
        queueSize: this.playlist.queue.length,
        isAuthenticated: this.isAuthenticated,
        userId: this.userId,
        // DJ Waitlist info
        userQueuePosition: this.getUserQueuePosition(),
        userTracksInQueue: this.getUserTracksInQueue(),
        isUsersTurn: this.isUsersTurn(),
        currentDj: this.getCurrentDj(),
        // Personal playlist
        personalPlaylist: this.getPersonalPlaylist()
      }
    });
    window.dispatchEvent(event);
  }

  /**
   * Fetch video metadata using noembed.com with YouTube fallback
   */
  private async fetchMetadata(url: string): Promise<{ title?: string; thumbnail?: string; duration?: number }> {
    try {
      // Try noembed first
      const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.title) {
          console.log('[PlaylistManager] Got title from noembed:', data.title);
          return {
            title: data.title,
            thumbnail: data.thumbnail_url || undefined,
            duration: data.duration || undefined
          };
        }
      }
    } catch (error) {
      console.warn('[PlaylistManager] noembed failed:', error);
    }

    // Fallback: Try YouTube oEmbed directly for YouTube URLs
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      try {
        const ytResponse = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (ytResponse.ok) {
          const ytData = await ytResponse.json();
          console.log('[PlaylistManager] Got title from YouTube oEmbed:', ytData.title);
          return {
            title: ytData.title || undefined,
            thumbnail: ytData.thumbnail_url || undefined,
            duration: undefined
          };
        }
      } catch (error) {
        console.warn('[PlaylistManager] YouTube oEmbed failed:', error);
      }
    }

    // Fallback: Try SoundCloud oEmbed for SoundCloud URLs
    if (url.includes('soundcloud.com')) {
      try {
        const scResponse = await fetch(`https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (scResponse.ok) {
          const scData = await scResponse.json();
          console.log('[PlaylistManager] Got title from SoundCloud oEmbed:', scData.title);
          return {
            title: scData.title || undefined,
            thumbnail: scData.thumbnail_url || undefined,
            duration: undefined
          };
        }
      } catch (error) {
        console.warn('[PlaylistManager] SoundCloud oEmbed failed:', error);
      }
    }

    console.warn('[PlaylistManager] Could not fetch metadata for:', url);
    return {};
  }

  /**
   * Fetch YouTube video duration via YouTube Data API proxy or oEmbed
   * Returns duration in seconds, or null if unknown
   */
  private async fetchVideoDuration(url: string, platform: string, embedId?: string): Promise<number | null> {
    // For YouTube, try to get duration from a proxy endpoint
    if (platform === 'youtube' && embedId) {
      try {
        // Try our API endpoint that can check duration
        const response = await fetch(`/api/youtube/duration?videoId=${embedId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.duration) {
            return data.duration;
          }
        }
      } catch (error) {
        console.warn('[PlaylistManager] Could not fetch YouTube duration:', error);
      }
    }

    // Duration check not available for this platform
    return null;
  }

  /**
   * Check if a title is a placeholder (e.g., "Track 1234")
   */
  private isPlaceholderTitle(title?: string): boolean {
    if (!title) return true;
    return /^Track \d+$/i.test(title);
  }

  /**
   * Fetch actual YouTube title via oEmbed
   */
  private async fetchYouTubeTitle(videoId: string): Promise<string | null> {
    try {
      const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (response.ok) {
        const data = await response.json();
        return data.title || null;
      }
    } catch (error) {
      console.warn('[PlaylistManager] Could not fetch YouTube title:', error);
    }
    return null;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  /**
   * Get current playlist state
   */
  get queue(): GlobalPlaylistItem[] {
    return this.playlist.queue;
  }

  get currentIndex(): number {
    return this.playlist.currentIndex;
  }

  get isPlaying(): boolean {
    return this.playlist.isPlaying;
  }

  get currentItem(): GlobalPlaylistItem | null {
    return this.playlist.queue[this.playlist.currentIndex] || null;
  }

  get authenticated(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Set volume (0-100)
   */
  setVolume(volume: number): void {
    this.player.setVolume(volume);
  }

  /**
   * Get user's position in the DJ waitlist (1-based)
   * Returns null if user is not in the queue
   */
  getUserQueuePosition(): number | null {
    if (!this.userId) return null;
    const index = this.playlist.queue.findIndex(item => item.addedBy === this.userId);
    return index >= 0 ? index + 1 : null;
  }

  /**
   * Get count of user's tracks currently in queue
   */
  getUserTracksInQueue(): number {
    if (!this.userId) return 0;
    return this.playlist.queue.filter(item => item.addedBy === this.userId).length;
  }

  /**
   * Check if it's currently the user's turn (their track is playing)
   */
  isUsersTurn(): boolean {
    if (!this.userId) return false;
    const currentItem = this.playlist.queue[0];
    return currentItem?.addedBy === this.userId;
  }

  /**
   * Get current DJ info (who's track is playing)
   */
  getCurrentDj(): { userId: string; userName: string } | null {
    const currentItem = this.playlist.queue[0];
    if (!currentItem) return null;
    return {
      userId: currentItem.addedBy || '',
      userName: currentItem.addedByName || 'Anonymous'
    };
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    this.clearTrackTimer();
    this.stopCountdown();
    if (this.pusherChannel) {
      this.pusherChannel.unbind_all();
      const pusher = (window as any).pusherInstance;
      if (pusher) {
        pusher.unsubscribe('live-playlist');
      }
    }
    this.stopPlaylistMeters();
    this.player.destroy();
  }
}

// Add Pusher type to window
declare global {
  interface Window {
    Pusher: any;
  }
}
