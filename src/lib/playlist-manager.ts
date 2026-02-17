// src/lib/playlist-manager.ts
// Global playlist manager - synced across all viewers via Pusher

import type { GlobalPlaylistItem, GlobalPlaylist } from './types';
import { EmbedPlayerManager } from './embed-player';
import { parseMediaUrl } from './url-parser';

const PLAYLIST_HISTORY_KEY = 'freshwax_playlist_history';
const RECENTLY_PLAYED_KEY = 'freshwax_recently_played';
const PERSONAL_PLAYLIST_KEY = 'freshwax_personal_playlist';
const MAX_HISTORY_SIZE = 100;
const MAX_PERSONAL_PLAYLIST_SIZE = 500; // Increased from 50
const TRACK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between same tracks
const MAX_TRACK_DURATION_MS = 10 * 60 * 1000; // 10 minutes max per track
const MAX_TRACK_DURATION_SECONDS = 10 * 60; // 10 minutes in seconds for validation

// Local playlist server (H: drive MP3s via Cloudflare tunnel)
const LOCAL_PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';

// Fallback thumbnail for audio files without thumbnails
const AUDIO_THUMBNAIL_FALLBACK = '/place-holder.webp';

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
  private globalRecentlyPlayed: any[] = []; // Recently played from Pusher (global)
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

    this.player = new EmbedPlayerManager(containerId, {
      onEnded: () => this.handleTrackEnded(),
      onError: (error) => this.handlePlaybackError(error),
      onReady: () => this.handlePlayerReady(),
      onStateChange: (state) => this.handleStateChange(state),
      onTitleUpdate: (title) => this.handleTitleUpdate(title)
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
      }
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
      this.handleTrackEnded();
    }, MAX_TRACK_DURATION_MS);
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

    // Load global playlist from server
    await this.loadFromServer();

    // Load personal playlist from D1 if authenticated
    if (this.isAuthenticated && this.userId) {
      await this.loadPersonalPlaylistFromServer();
    }

    // Subscribe to Pusher for real-time updates
    await this.subscribeToPusher();

    // If playlist is playing, start playback
    if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
      await this.playCurrent();
    } else if (this.playlist.queue.length === 0 && !window.isLiveStreamActive) {
      // Queue is empty and no live stream - try to auto-start playlist
      // Small delay to ensure page is ready
      setTimeout(() => this.startAutoPlay(), 500);
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
    const pusherConfig = window.PUSHER_CONFIG;
    if (!pusherConfig?.key) {
      console.warn('[PlaylistManager] Pusher config not found');
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
      console.error('[PlaylistManager] Pusher subscription error:', error);
    }
  }

  /**
   * Handle remote playlist update from Pusher
   */
  private async handleRemoteUpdate(newPlaylist: GlobalPlaylist & { recentlyPlayed?: any[] }): Promise<void> {
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
      if (oldItem && !this.isPlaceholderTitle(oldItem.title) && this.isPlaceholderTitle(item.title)) {
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
      const parsed = parseMediaUrl(url.trim());

      if (!parsed.isValid) {
        return { success: false, error: parsed.error || 'Invalid URL' };
      }

      // Check duration for YouTube videos before adding
      if (parsed.platform === 'youtube' && parsed.embedId) {
        const duration = await this.fetchVideoDuration(url.trim(), parsed.platform, parsed.embedId);
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
      const idToken = await this.getAuthToken();
      const postHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) postHeaders['Authorization'] = `Bearer ${idToken}`;

      const response = await fetch('/api/playlist/global/', {
        method: 'POST',
        headers: postHeaders,
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
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error adding item:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add to queue' };
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
      const idToken = await this.getAuthToken();
      const deleteHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) deleteHeaders['Authorization'] = `Bearer ${idToken}`;

      const response = await fetch('/api/playlist/global/', {
        method: 'DELETE',
        headers: deleteHeaders,
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
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error removing item:', error);
    }
  }

  /**
   * Play playlist (viewer action - syncs to all)
   */
  async play(): Promise<void> {
    // Don't play if live stream is active
    if (window.isLiveStreamActive) {
      return;
    }

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
    this.isPausedLocally = true; // Set local pause flag
    this.clearTrackTimer();
    this.stopCountdown();
    await this.player.pause();
    this.stopPlaylistMeters();
    this.disableEmojis();
  }

  /**
   * Resume playback (LOCAL ONLY - syncs to current global position)
   */
  async resume(): Promise<void> {
    if (this.playlist.queue.length === 0) return;

    this.isPausedLocally = false; // Clear local pause flag

    // Fetch latest playlist state to get current trackStartedAt
    try {
      const response = await fetch('/api/playlist/global/');
      const result = await response.json();
      if (result.success && result.playlist) {
        this.playlist = result.playlist;
      }
    } catch (error: unknown) {
      console.warn('[PlaylistManager] Could not fetch latest state:', error);
    }

    // Resume and sync to current global position
    await this.player.play();
    this.enableEmojis();
    this.startPlaylistMeters();

    // Seek to current global position
    const syncPosition = this.calculateSyncPosition();
    if (syncPosition > 2) {
      await this.player.seekTo(syncPosition);
    }

    // Restart countdown display
    this.updateDurationDisplay();

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
    await this.handleTrackEnded();
  }

  /**
   * Start auto-play from history when queue is empty and no live stream
   * Called by live-stream.js when going offline with empty queue
   * IMPORTANT: Uses server to pick track so all clients play the same thing
   */
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
      console.warn('[PlaylistManager] Auto-play skipped - player container not found');
      return false;
    }

    // Ask SERVER to pick a track - ensures all clients get the same track
    try {
      const response = await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'startAutoPlay'
        })
      });

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
      console.error('[PlaylistManager] Error requesting auto-play from server:', error);
      return false;
    }
  }

  /**
   * Send control action to server
   */
  private async sendControlAction(action: string): Promise<void> {
    try {
      const response = await fetch('/api/playlist/global/', {
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
    } catch (error: unknown) {
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

  /**
   * Play current track (with lock to prevent race conditions)
   */
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
      console.warn('[PlaylistManager] Player container not found - skipping playback');
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
      this.showVideoPlayer();

      // Log to local play history only (server history updated when track ENDS)
      this.logToHistory(currentItem);

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
        this.player.setPendingSeek(syncPosition);
      }

      await this.player.loadItem(currentItem);

      // Check duration after loading - skip if exceeds 10 minute limit
      try {
        // Wait a moment for player to have duration info
        await new Promise(resolve => setTimeout(resolve, 1000));
        const duration = await this.player.getDuration();

        if (duration > MAX_TRACK_DURATION_SECONDS) {
          this.clearTrackTimer();
          // Don't unlock yet - let handleTrackEnded handle it
          this.isPlayingLocked = false;
          await this.handleTrackEnded();
          return;
        }
      } catch (e) {
        console.warn('[PlaylistManager] Could not check duration, allowing track to play:', e);
      }

      this.renderUI();

    } catch (error: unknown) {
      console.error('[PlaylistManager] Error playing current:', error);
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
  }

  /**
   * Log item to server-side master history (for auto-play across all users)
   */
  private async logToServerHistory(item: GlobalPlaylistItem): Promise<void> {
    try {
      await fetch('/api/playlist/history/', {
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
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error logging to server history:', error);
    }
  }

  /**
   * Enable emoji reactions, audio meters, and chat
   */
  private enableEmojis(): void {
    window.emojiAnimationsEnabled = true;

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
    if (typeof window.setChatEnabled === 'function') {
      window.setChatEnabled(true);
    }

    // Setup chat channel for playlist mode if not already done
    if (typeof window.setupChat === 'function' && !window.playlistChatSetup) {
      window.setupChat('playlist-global');
      window.playlistChatSetup = true;
    }

    // Ensure stereo meters are visible for playlist (we use the same LED elements)
    const stereoMeters = document.getElementById('stereoMeters');
    const toggleMetersBtn = document.getElementById('toggleMetersBtn');
    if (stereoMeters) {
      stereoMeters.style.display = '';
    }
    // Hide toggle button since playlist meters are simulated (no audio context to toggle)
    if (toggleMetersBtn) {
      toggleMetersBtn.style.display = 'none';
    }

    this.startPlaylistMeters();
  }

  /**
   * Disable emoji reactions, audio meters, and chat (only if no live stream active)
   */
  private disableEmojis(): void {
    // Check if a live stream is active - don't disable anything if so
    const isLiveStreamActive = window.isLiveStreamActive;
    const streamDetectedThisSession = window.streamDetectedThisSession;

    if (isLiveStreamActive || streamDetectedThisSession) {
      return;
    }

    window.emojiAnimationsEnabled = false;

    const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
    reactionButtons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = true;
      btn.classList.add('disabled', 'reactions-disabled');
    });
    if (!isLiveStreamActive) {
      if (typeof window.setChatEnabled === 'function') {
        window.setChatEnabled(false);
      }

      // Reset playlist chat setup flag
      window.playlistChatSetup = false;
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
        // Show "Playlist" in genre, countdown goes in duration boxes
        genreEl.textContent = 'Playlist';
      }
      // Fetch duration after player is ready (updates npDuration and bottomDuration)
      this.updateDurationDisplay();
    } else {
      // Remove playlist mode class
      if (djInfoBar) {
        djInfoBar.classList.remove('playlist-mode');
      }
      // Only reset DJ name if no live stream is active (preserve relay/DJ name)
      const isLiveStreamActive = window.isLiveStreamActive;
      const streamDetectedThisSession = window.streamDetectedThisSession;
      const currentStreamData = window.currentStreamData;
      if (djNameEl && !isLiveStreamActive && !streamDetectedThisSession && !currentStreamData) {
        djNameEl.textContent = '--';
      }
      if (labelEl) {
        labelEl.textContent = 'NOW PLAYING';
      }
      // Only reset avatar if no live stream is active
      if (djAvatarEl && !isLiveStreamActive && !streamDetectedThisSession && !currentStreamData) {
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
    // Get current track ID
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
    this.isFetchingDuration = true;

    // Wait for metadata to load properly (especially for audio files)
    // This uses event listeners instead of polling for more reliable duration detection
    let duration = 0;
    try {
      // First try the event-based metadata wait (10 second timeout)
      duration = await this.player.waitForMetadata(10000);

      // If that didn't work, try direct getDuration as fallback
      if (duration <= 0) {
        // Small delay then retry
        await new Promise(resolve => setTimeout(resolve, 500));
        duration = await this.player.getDuration();
      }

      // If still no duration, check if track has stored duration
      if (duration <= 0 && currentTrack?.duration) {
        duration = currentTrack.duration;
      }
    } catch (error: unknown) {
      console.warn('[PlaylistManager] Error getting duration:', error);
    }

    this.isFetchingDuration = false;

    if (duration > 0) {
      this.startCountdown(duration);
    } else {
      console.warn('[PlaylistManager] Could not get duration from any source');
      // Last resort: try to calculate from trackStartedAt and expected end
      const trackStartedAt = this.playlist.trackStartedAt;
      if (trackStartedAt && currentTrack?.duration) {
        const elapsed = (Date.now() - trackStartedAt) / 1000;
        const remaining = Math.max(0, currentTrack.duration - elapsed);
        if (remaining > 0) {
          this.startCountdown(currentTrack.duration);
          return;
        }
      }
      // Final fallback: show elapsed time instead of countdown
      this.startElapsedTimer();
    }
  }

  /**
   * Start countdown display - uses cached values for stability
   */
  private startCountdown(totalDuration: number): void {
    const bottomDurationEl = document.getElementById('bottomDuration');
    const previewDurationEl = document.getElementById('previewDuration');
    const genreEl = document.getElementById('streamGenre');

    if (genreEl) {
      genreEl.textContent = 'Playlist';
    }

    // Cache the start time for stable countdown
    const countdownStartTime = Date.now();
    let lastPlayerTime = 0;

    // Get initial player time synchronously if possible
    this.player.getCurrentTime().then(t => { lastPlayerTime = t; }).catch(() => {});

    const updateDisplay = () => {
      // Use player time if available, otherwise estimate from wall clock
      this.player.getCurrentTime().then(currentTime => {
        // Sanity check - if time jumped backwards or too far forward, use last known
        if (currentTime < lastPlayerTime - 2 || currentTime > lastPlayerTime + 3) {
          // Estimate based on wall clock since countdown started
          const elapsedSinceStart = (Date.now() - countdownStartTime) / 1000;
          currentTime = Math.min(lastPlayerTime + elapsedSinceStart, totalDuration);
        }
        lastPlayerTime = currentTime;

        const remaining = Math.max(0, totalDuration - currentTime);
        const formattedTime = this.formatDuration(remaining);
        if (bottomDurationEl) bottomDurationEl.textContent = formattedTime;
        if (previewDurationEl) previewDurationEl.textContent = formattedTime;
      }).catch(() => {
        // On error, estimate based on wall clock
        const elapsed = (Date.now() - countdownStartTime) / 1000 + lastPlayerTime;
        const remaining = Math.max(0, totalDuration - elapsed);
        const formattedTime = this.formatDuration(remaining);
        if (bottomDurationEl) bottomDurationEl.textContent = formattedTime;
        if (previewDurationEl) previewDurationEl.textContent = formattedTime;
      });
    };

    // Update immediately then every second
    updateDisplay();
    this.countdownInterval = window.setInterval(updateDisplay, 1000);
  }

  /**
   * Fallback: show elapsed time when duration is unknown
   */
  private startElapsedTimer(): void {
    const bottomDurationEl = document.getElementById('bottomDuration');
    const previewDurationEl = document.getElementById('previewDuration');

    // Use server's trackStartedAt if available for accurate elapsed time
    const serverStartTime = this.playlist.trackStartedAt
      ? new Date(this.playlist.trackStartedAt).getTime()
      : Date.now();

    const updateDisplay = () => {
      const elapsed = Math.floor((Date.now() - serverStartTime) / 1000);
      const formattedTime = this.formatDuration(elapsed);
      if (bottomDurationEl) bottomDurationEl.textContent = formattedTime;
      if (previewDurationEl) previewDurationEl.textContent = formattedTime;
    };

    updateDisplay();
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
    this.countdownTrackId = null;
  }

  /**
   * Load play history from localStorage
   */
  private loadPlayHistory(): void {
    try {
      const stored = localStorage.getItem(PLAYLIST_HISTORY_KEY);
      if (stored) {
        this.playHistory = JSON.parse(stored);
      }
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
   * PRIORITY: Local server MP3s > YouTube history
   * Uses 60-minute cooldown and never repeats the last played track
   */
  private async pickRandomFromHistory(): Promise<GlobalPlaylistItem | null> {
    // First, try the local playlist server (H: drive MP3s) - more reliable, no bot issues
    const localTrack = await this.pickRandomFromLocalServer();
    if (localTrack) {
      return localTrack;
    }

    // Fallback to server-side YouTube history if local server is unavailable
    try {
      const response = await fetch('/api/playlist/history/');
      const result = await response.json();
      if (result.success && result.items && result.items.length > 0) {
        const serverHistory = result.items;

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

        if (availableTracks.length === 0) {
          // All tracks on cooldown - just pick a random one that isn't the last played
          const fallbackTracks = serverHistory.filter((entry: any) => entry.url !== this.lastPlayedUrl);
          if (fallbackTracks.length > 0) {
            const randomIndex = Math.floor(Math.random() * fallbackTracks.length);
            const selected = fallbackTracks[randomIndex];
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

        // Fetch real title if it's a placeholder (e.g., "Track 1234")
        let title = selected.title;
        if (this.isPlaceholderTitle(title) && selected.embedId) {
          const realTitle = await this.fetchYouTubeTitle(selected.embedId);
          if (realTitle) {
            title = realTitle;
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
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error fetching server history:', error);
    }

    // Fallback to local history if server fails
    if (this.playHistory.length > 0) {
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

    return null;
  }

  /**
   * Pick a random track from the local playlist server (H: drive MP3s)
   * Returns null if server is unavailable
   */
  private async pickRandomFromLocalServer(): Promise<GlobalPlaylistItem | null> {
    try {
      // Use authenticated proxy to prevent unauthenticated inventory disclosure
      const auth = window.firebase?.auth?.();
      const currentUser = auth?.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;

      const fetchHeaders: Record<string, string> = {};
      if (idToken) {
        fetchHeaders['Authorization'] = `Bearer ${idToken}`;
      }

      const response = await fetch('/api/playlist/server-list/', {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        console.warn('[PlaylistManager] Local playlist server returned', response.status);
        return null;
      }

      const data = await response.json();
      if (!data.files || data.files.length === 0) {
        console.warn('[PlaylistManager] Local playlist server has no files');
        return null;
      }

      // Filter out recently played tracks
      const now = Date.now();
      const availableTracks = data.files.filter((file: any) => {
        const url = `${LOCAL_PLAYLIST_SERVER}${file.url}`;
        if (url === this.lastPlayedUrl) return false;
        const timestamp = this.recentlyPlayed.get(url);
        if (!timestamp) return true;
        return (now - timestamp) >= TRACK_COOLDOWN_MS;
      });

      // Pick from available or all if all on cooldown
      const tracksToPickFrom = availableTracks.length > 0
        ? availableTracks
        : data.files.filter((f: any) => `${LOCAL_PLAYLIST_SERVER}${f.url}` !== this.lastPlayedUrl);

      if (tracksToPickFrom.length === 0) {
        console.warn('[PlaylistManager] No local tracks available');
        return null;
      }

      // Prefer tracks with thumbnails
      const tracksWithThumbs = tracksToPickFrom.filter((f: any) => f.thumbnail);
      const finalTracks = tracksWithThumbs.length > 0 ? tracksWithThumbs : tracksToPickFrom;

      const randomIndex = Math.floor(Math.random() * finalTracks.length);
      const selected = finalTracks[randomIndex];
      const url = `${LOCAL_PLAYLIST_SERVER}${selected.url}`;

      // Use track's own thumbnail if available, otherwise fallback
      const thumbnail = selected.thumbnail
        ? `${LOCAL_PLAYLIST_SERVER}${selected.thumbnail}`
        : AUDIO_THUMBNAIL_FALLBACK;

      return {
        id: this.generateId(),
        url: url,
        platform: 'direct',
        title: selected.name,
        thumbnail: thumbnail,
        duration: selected.duration || undefined,
        addedAt: new Date().toISOString(),
        addedBy: 'system',
        addedByName: 'Auto-Play'
      };
    } catch (error: unknown) {
      console.warn('[PlaylistManager] Local playlist server error:', error);
      return null;
    }
  }

  /**
   * Clear play history
   */
  clearPlayHistory(): void {
    this.playHistory = [];
    this.savePlayHistory();
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
      }
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error loading personal playlist:', error);
      this.personalPlaylist = [];
    }
  }

  /**
   * Load personal playlist from D1 (called when user authenticates)
   * Cloud sync is Plus-only - Standard users only use localStorage
   */
  async loadPersonalPlaylistFromServer(): Promise<void> {
    if (!this.userId) {
      return;
    }

    try {
      const response = await fetch(`/api/playlist/personal/?userId=${encodeURIComponent(this.userId)}`);
      const result = await response.json();

      // Check if user has Plus for cloud sync
      if (result.isPlus === false) {
        // Store Plus status for later use
        window.userHasCloudSync = false;
        return;
      }

      window.userHasCloudSync = true;

      if (result.success && Array.isArray(result.playlist)) {
        // Merge with localStorage (D1 takes priority for duplicates)
        const d1Items = result.playlist;
        const localItems = this.personalPlaylist;

        // Create a map of existing URLs from D1
        const d1Urls = new Set(d1Items.map((item: any) => item.url));

        // Add local items that aren't in D1
        const mergedItems = [...d1Items];
        for (const localItem of localItems) {
          if (!d1Urls.has(localItem.url)) {
            mergedItems.push(localItem);
          }
        }

        this.personalPlaylist = mergedItems;
        // Save merged list back to both localStorage and D1
        this.savePersonalPlaylist();
        this.savePersonalPlaylistToServer();
      }
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error loading personal playlist from D1:', error);
      // Keep using localStorage data
    }
  }

  /**
   * Save personal playlist to localStorage
   */
  private savePersonalPlaylist(): void {
    try {
      localStorage.setItem(PERSONAL_PLAYLIST_KEY, JSON.stringify(this.personalPlaylist));
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error saving personal playlist to localStorage:', error);
    }
  }

  /**
   * Save personal playlist to D1 (async, non-blocking)
   * Only saves for Plus users - Standard users use local storage only
   */
  private async savePersonalPlaylistToServer(): Promise<void> {
    if (!this.userId) return;

    // Skip if user doesn't have cloud sync (not Plus)
    if (window.userHasCloudSync === false) {
      return;
    }

    try {
      // Get Firebase auth token for authorization
      const auth = window.firebase?.auth?.();
      const currentUser = auth?.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;

      if (!idToken) {
        console.warn('[PlaylistManager] No auth token, skipping cloud save');
        return;
      }

      const response = await fetch('/api/playlist/personal/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          userId: this.userId,
          items: this.personalPlaylist
        })
      });

      const result = await response.json();

      if (result.isPlus === false) {
        // User is not Plus - mark it and skip future saves
        window.userHasCloudSync = false;
        return;
      }

    } catch (error: unknown) {
      console.error('[PlaylistManager] Error saving personal playlist to D1:', error);
    }
  }

  /**
   * Add a track to personal playlist (for later use)
   * Plus users: 1000 tracks with cloud sync
   * Standard users: 100 tracks local only
   * @param url - The media URL
   * @param providedTitle - Optional title if already known (e.g., from queue)
   * @param providedThumbnail - Optional thumbnail if already known
   */
  async addToPersonalPlaylist(url: string, providedTitle?: string, providedThumbnail?: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!url || !url.trim()) {
      return { success: false, error: 'Please enter a URL' };
    }

    // Check if already in personal playlist
    const alreadyInPlaylist = this.personalPlaylist.some(item => item.url === url.trim());
    if (alreadyInPlaylist) {
      return { success: false, error: 'This track is already in your playlist' };
    }

    // Determine max size based on subscription
    const hasCloudSync = window.userHasCloudSync === true;
    const maxSize = hasCloudSync ? 1000 : 100;

    // Check max size
    if (this.personalPlaylist.length >= maxSize) {
      if (hasCloudSync) {
        return { success: false, error: `Your cloud playlist is full (${maxSize} tracks max)` };
      } else {
        return { success: false, error: `Your playlist is full (${maxSize} tracks). Upgrade to Plus for 1,000 tracks with cloud sync!` };
      }
    }

    try {
      // Parse URL
      const parsed = parseMediaUrl(url.trim());

      if (!parsed.isValid) {
        return { success: false, error: parsed.error || 'Invalid URL' };
      }

      // Use provided title/thumbnail or fetch metadata
      let title = providedTitle;
      let thumbnail = providedThumbnail;

      if (!title || !thumbnail) {
        const metadata = await this.fetchMetadata(url.trim());
        title = title || metadata.title;
        thumbnail = thumbnail || metadata.thumbnail;
      }

      // Fallback thumbnail for YouTube
      if (!thumbnail && parsed.platform === 'youtube' && parsed.embedId) {
        thumbnail = `https://img.youtube.com/vi/${parsed.embedId}/mqdefault.jpg`;
      }

      const item: PersonalPlaylistItem = {
        id: this.generateId(),
        url: url.trim(),
        platform: parsed.platform,
        embedId: parsed.embedId,
        title: title || 'Untitled',
        thumbnail,
        addedAt: new Date().toISOString()
      };

      this.personalPlaylist.push(item);
      this.savePersonalPlaylist();
      this.savePersonalPlaylistToServer(); // Save to D1 for persistence
      this.renderUI();

      return { success: true, message: 'Added to your playlist' };
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error adding to personal playlist:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add to playlist' };
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
      this.savePersonalPlaylistToServer(); // Save to D1 for persistence
      this.renderUI();
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
    this.savePersonalPlaylistToServer(); // Save to D1 for persistence
    this.renderUI();
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
   * Handle track ended - tell SERVER to pick next track
   * Server is the source of truth to ensure all clients play the same track
   */
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
      const response = await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'trackEnded',
          trackId: finishedItem.id, // Prevent race conditions
          finishedTrackTitle: finishedItem.title // Send resolved title for recently played
        })
      });

      const result = await response.json();
      if (result.success && result.playlist) {
        // Update local state with server response (server is source of truth)
        this.playlist = result.playlist;

        // Play the new track (whether we were first or not - server has the correct track)
        if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
          await this.playCurrent();
        } else {
          // No tracks - show offline state
          await this.player.destroy();
          this.disableEmojis();
          this.updateNowPlayingDisplay(null);
          this.showOfflineOverlay();
        }
      }
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error calling trackEnded:', error);
      // Fallback: just stop playback on error
      this.playlist.isPlaying = false;
      await this.player.destroy();
      this.disableEmojis();
      this.updateNowPlayingDisplay(null);
      this.showOfflineOverlay();
    }

    this.renderUI();
  }

  /**
   * Handle playback error
   */
  private async handlePlaybackError(error: string): Promise<void> {
    console.error('[PlaylistManager] Playback error:', error);

    // Check if container exists - if not, stop trying
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.warn('[PlaylistManager] Container not found - player may not be on this page. Stopping playback attempts.');
      this.consecutiveErrors = 0;
      return;
    }

    // Parse structured error info (from enhanced YouTube error handling)
    let errorInfo: { type?: string; code?: number; message?: string } = {};
    try {
      errorInfo = JSON.parse(error);
    } catch {
      // Legacy error format - just a string
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

    // Prevent infinite loops - max 3 consecutive errors
    if (this.consecutiveErrors >= 3) {
      console.warn('[PlaylistManager] Too many consecutive errors, stopping playback');
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

  /**
   * Mark a video as blocked/unavailable - removes it from server history
   * so it won't be auto-played again
   */
  private async markVideoAsBlocked(url: string, embedId?: string): Promise<void> {
    try {
      const response = await fetch('/api/playlist/history/', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          embedId,
          reason: 'blocked'
        })
      });

      const result = await response.json();
      if (result.success) {
      } else {
        console.warn('[PlaylistManager] Failed to remove blocked video from history:', result.error);
      }
    } catch (error: unknown) {
      console.error('[PlaylistManager] Error marking video as blocked:', error);
    }
  }

  /**
   * Handle player ready
   */
  private handlePlayerReady(): void {
    // Reset error counter on successful playback
    this.consecutiveErrors = 0;
  }

  /**
   * Handle state change
   */
  private handleStateChange(state: string): void {
    // Track when playback actually started for stable play detection
    if (state === 'playing') {
      this.playbackStartedTime = Date.now();
      this.playlist.isPlaying = true;
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

  /**
   * Handle title update from player (e.g., YouTube video data)
   */
  private handleTitleUpdate(title: string): void {
    const currentItem = this.playlist.queue[this.playlist.currentIndex];
    if (currentItem && this.isPlaceholderTitle(currentItem.title)) {
      currentItem.title = title;
      // Update the UI with the new title
      this.renderUI();
      // Note: Server history is updated with correct title when track ends (trackEnded action)
    }
  }

  /**
   * Load playlist from server
   */
  private async loadFromServer(): Promise<void> {
    try {
      const response = await fetch('/api/playlist/global/');
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
      await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          playlist: this.playlist
        })
      });

    } catch (error: unknown) {
      console.error('[PlaylistManager] Error clearing stale playlist:', error);
    }
  }

  /**
   * Render UI (dispatch event for components to update)
   */
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
          return {
            title: data.title,
            thumbnail: data.thumbnail_url || undefined,
            duration: data.duration || undefined
          };
        }
      }
    } catch (error: unknown) {
      console.warn('[PlaylistManager] noembed failed:', error);
    }

    // Fallback: Try YouTube oEmbed directly for YouTube URLs
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      try {
        const ytResponse = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (ytResponse.ok) {
          const ytData = await ytResponse.json();
          return {
            title: ytData.title || undefined,
            thumbnail: ytData.thumbnail_url || undefined,
            duration: undefined
          };
        }
      } catch (error: unknown) {
        console.warn('[PlaylistManager] YouTube oEmbed failed:', error);
      }
    }

    // Fallback: Try SoundCloud oEmbed for SoundCloud URLs
    if (url.includes('soundcloud.com')) {
      try {
        const scResponse = await fetch(`https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (scResponse.ok) {
          const scData = await scResponse.json();
          return {
            title: scData.title || undefined,
            thumbnail: scData.thumbnail_url || undefined,
            duration: undefined
          };
        }
      } catch (error: unknown) {
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
        const response = await fetch(`/api/youtube/duration/?videoId=${embedId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.duration) {
            return data.duration;
          }
        }
      } catch (error: unknown) {
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
    } catch (error: unknown) {
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

  private async getAuthToken(): Promise<string | null> {
    try {
      const auth = (window as any).firebase?.auth?.();
      const currentUser = auth?.currentUser;
      return currentUser ? await currentUser.getIdToken() : null;
    } catch {
      return null;
    }
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

  /**
   * Check if audio is actually playing (not paused/blocked by browser)
   */
  get isActuallyPlaying(): boolean {
    return this.player.isActuallyPlaying();
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
      const pusher = window.pusherInstance;
      if (pusher) {
        pusher.unsubscribe('live-playlist');
      }
    }
    this.stopPlaylistMeters();
    this.player.destroy();
  }
}

