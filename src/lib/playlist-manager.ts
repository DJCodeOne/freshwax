// src/lib/playlist-manager.ts
// Global playlist manager - synced across all viewers via Pusher

import type { GlobalPlaylistItem, GlobalPlaylist } from './types';
import { EmbedPlayerManager } from './embed-player';

const PLAYLIST_HISTORY_KEY = 'freshwax_playlist_history';
const RECENTLY_PLAYED_KEY = 'freshwax_recently_played';
const MAX_HISTORY_SIZE = 100;
const TRACK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between same tracks
const MAX_TRACK_DURATION_MS = 10 * 60 * 1000; // 10 minutes max per track

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

export class PlaylistManager {
  private userId: string | null = null;
  private userName: string | null = null;
  private playlist: GlobalPlaylist;
  private player: EmbedPlayerManager;
  private isAuthenticated: boolean = false;
  public wasPausedForStream: boolean = false;
  private playHistory: PlaylistHistoryEntry[] = [];
  private pusherChannel: any = null;
  private isSubscribed: boolean = false;
  private trackTimer: number | null = null; // Timer for max track duration
  private recentlyPlayed: Map<string, number> = new Map(); // URL -> timestamp

  constructor(containerId: string) {
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

    // Load play history and recently played
    this.loadPlayHistory();
    this.loadRecentlyPlayed();
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

    // Update local playlist
    this.playlist = newPlaylist;

    const newCurrentItem = this.playlist.queue[this.playlist.currentIndex];

    // Determine if we need to change what's playing:
    // 1. We weren't playing but should start now (first item added)
    // 2. The actual item at currentIndex changed (e.g., "next" was triggered)
    const shouldStartPlaying = !wasPlaying && this.playlist.isPlaying && this.playlist.queue.length > 0;
    const currentItemChanged = oldCurrentItem?.id !== newCurrentItem?.id && newCurrentItem != null;

    if (shouldStartPlaying) {
      // Starting playback for the first time
      await this.playCurrent();
    } else if (this.playlist.isPlaying && currentItemChanged) {
      // The current track changed (next/skip was triggered, not just queue addition)
      await this.playCurrent();
    } else if (!this.playlist.isPlaying && wasPlaying) {
      // Playlist was paused remotely
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
   * Pause playlist
   */
  async pause(): Promise<void> {
    this.clearTrackTimer();
    await this.sendControlAction('pause');
  }

  /**
   * Resume playback
   */
  async resume(): Promise<void> {
    if (this.playlist.queue.length === 0) return;
    await this.sendControlAction('play');
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
   * Play current track
   */
  private async playCurrent(): Promise<void> {
    const currentItem = this.playlist.queue[this.playlist.currentIndex];
    if (!currentItem) return;

    try {
      // Show video player and hide overlays
      this.showVideoPlayer();

      // Log to play history
      this.logToHistory(currentItem);

      // Mark URL as played (for 1-hour cooldown)
      this.markAsPlayed(currentItem.url);

      // Start 10-minute timer
      this.startTrackTimer();

      // Enable emoji reactions
      this.enableEmojis();

      // Update NOW PLAYING display
      this.updateNowPlayingDisplay(currentItem);

      await this.player.loadItem(currentItem);
      this.renderUI();

      console.log('[PlaylistManager] Now playing:', currentItem.title || currentItem.url);
    } catch (error) {
      console.error('[PlaylistManager] Error playing current:', error);
      // Try next track
      await this.playNext();
    }
  }

  /**
   * Log item to play history for offline playlist creation
   */
  private logToHistory(item: GlobalPlaylistItem): void {
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
   * Enable emoji reactions and audio meters
   */
  private enableEmojis(): void {
    (window as any).emojiAnimationsEnabled = true;

    const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
    reactionButtons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = false;
      btn.classList.remove('disabled', 'reactions-disabled');
    });

    // Hide "Sign in to chat" prompt
    const loginPrompt = document.getElementById('loginPrompt');
    if (loginPrompt) {
      loginPrompt.style.display = 'none';
    }

    // Start audio LED meters
    if (typeof (window as any).startGlobalMeters === 'function') {
      (window as any).startGlobalMeters();
    }

    this.startPlaylistMeters();
    console.log('[PlaylistManager] Emoji reactions and audio meters enabled');
  }

  /**
   * Disable emoji reactions and audio meters
   */
  private disableEmojis(): void {
    (window as any).emojiAnimationsEnabled = false;

    const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
    reactionButtons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = true;
      btn.classList.add('disabled', 'reactions-disabled');
    });

    this.stopPlaylistMeters();
  }

  private playlistMeterInterval: number | null = null;

  /**
   * Start simulated audio meters for playlist playback
   */
  private startPlaylistMeters(): void {
    if (this.playlistMeterInterval) return;

    const leftLeds = document.querySelectorAll('#leftMeter .led');
    const rightLeds = document.querySelectorAll('#rightMeter .led');

    if (leftLeds.length === 0 || rightLeds.length === 0) return;

    this.playlistMeterInterval = window.setInterval(() => {
      if (!this.playlist.isPlaying) {
        this.stopPlaylistMeters();
        return;
      }

      const baseLevel = 4 + Math.random() * 5;
      const leftLevel = Math.floor(baseLevel + (Math.random() - 0.5) * 4);
      const rightLevel = Math.floor(baseLevel + (Math.random() - 0.5) * 4);

      leftLeds.forEach((led, i) => led.classList.toggle('active', i < leftLevel));
      rightLeds.forEach((led, i) => led.classList.toggle('active', i < rightLevel));
    }, 100);

    console.log('[PlaylistManager] Audio meters started');
  }

  /**
   * Stop simulated audio meters
   */
  private stopPlaylistMeters(): void {
    if (this.playlistMeterInterval) {
      clearInterval(this.playlistMeterInterval);
      this.playlistMeterInterval = null;
    }

    document.querySelectorAll('.led-strip .led').forEach(led => led.classList.remove('active'));
    console.log('[PlaylistManager] Audio meters stopped');
  }

  /**
   * Update NOW PLAYING display at bottom of screen
   */
  private updateNowPlayingDisplay(item: GlobalPlaylistItem | null): void {
    const djNameEl = document.getElementById('controlsDjName');
    const djAvatarEl = document.getElementById('djAvatar') as HTMLImageElement;
    const genreEl = document.getElementById('streamGenre');
    const labelEl = document.querySelector('.dj-info-label');

    if (item) {
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
        const platformNames: Record<string, string> = {
          youtube: 'YouTube',
          vimeo: 'Vimeo',
          soundcloud: 'SoundCloud',
          direct: 'Direct Video'
        };
        genreEl.textContent = platformNames[item.platform] || item.platform;
      }
    } else {
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
   * Clear play history
   */
  clearPlayHistory(): void {
    this.playHistory = [];
    this.savePlayHistory();
    console.log('[PlaylistManager] Play history cleared');
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
    // Clear the track timer first
    this.clearTrackTimer();

    console.log('[PlaylistManager] Track ended, removing and playing next');

    const finishedItem = this.playlist.queue[this.playlist.currentIndex];
    if (!finishedItem) {
      console.log('[PlaylistManager] No item to remove');
      return;
    }

    // Remove the finished item from queue
    this.playlist.queue.splice(this.playlist.currentIndex, 1);

    // Adjust currentIndex to stay in bounds
    if (this.playlist.queue.length === 0) {
      // Queue is empty
      this.playlist.currentIndex = 0;
      this.playlist.isPlaying = false;
      await this.player.destroy();
      this.disableEmojis();
      this.updateNowPlayingDisplay(null);
      this.showOfflineOverlay();
    } else {
      // Keep currentIndex in bounds (it now points to the next item)
      if (this.playlist.currentIndex >= this.playlist.queue.length) {
        this.playlist.currentIndex = 0; // Wrap to start
      }
    }

    this.playlist.lastUpdated = new Date().toISOString();

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
  }

  /**
   * Handle state change
   */
  private handleStateChange(state: string): void {
    console.log('[PlaylistManager] State changed:', state);
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
        console.log('[PlaylistManager] Loaded global playlist:', this.playlist.queue.length, 'items');
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading from server:', error);
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
        userId: this.userId
      }
    });
    window.dispatchEvent(event);
  }

  /**
   * Fetch video metadata using noembed.com
   */
  private async fetchMetadata(url: string): Promise<{ title?: string; thumbnail?: string }> {
    try {
      const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
      if (!response.ok) return {};

      const data = await response.json();
      return {
        title: data.title || undefined,
        thumbnail: data.thumbnail_url || undefined
      };
    } catch (error) {
      console.warn('[PlaylistManager] Failed to fetch metadata:', error);
      return {};
    }
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
   * Cleanup on destroy
   */
  destroy(): void {
    this.clearTrackTimer();
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
