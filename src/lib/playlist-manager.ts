// src/lib/playlist-manager.ts
// Client-side playlist state manager

import type { PlaylistItem, UserPlaylist } from './types';
import { EmbedPlayerManager } from './embed-player';

const PLAYLIST_STORAGE_KEY = 'freshwax_playlist';
const PLAYLIST_HISTORY_KEY = 'freshwax_playlist_history';
const MAX_QUEUE_SIZE = 10;
const MAX_HISTORY_SIZE = 100;

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
  private playlist: UserPlaylist;
  private player: EmbedPlayerManager;
  private isAuthenticated: boolean = false;
  public wasPausedForStream: boolean = false;
  private playHistory: PlaylistHistoryEntry[] = [];

  constructor(containerId: string) {
    this.playlist = {
      userId: '',
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

    // Load play history
    this.loadPlayHistory();
  }

  /**
   * Initialize playlist manager
   */
  async initialize(userId?: string): Promise<void> {
    this.userId = userId || null;
    this.isAuthenticated = !!userId;

    if (this.isAuthenticated && userId) {
      // Load from Firebase
      await this.loadFromFirebase();
    } else {
      // Load from localStorage
      this.loadFromLocalStorage();
    }

    // If queue has items and was playing, start playback
    if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
      await this.playCurrent();
    }

    this.renderUI();
  }

  /**
   * Add item to queue
   */
  async addItem(url: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!url || !url.trim()) {
      return { success: false, error: 'Please enter a URL' };
    }

    if (this.playlist.queue.length >= MAX_QUEUE_SIZE) {
      return {
        success: false,
        error: `Queue is full (${MAX_QUEUE_SIZE} items max). Wait for the current track to end before trying again.`
      };
    }

    try {
      if (this.isAuthenticated && this.userId) {
        // Add via API
        const response = await fetch('/api/playlist/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: this.userId, url: url.trim() })
        });

        const result = await response.json();

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to add to queue' };
        }

        // Reload from server
        await this.loadFromFirebase();

        // Jump to the newly added item (last in queue) and start playing
        const newIndex = this.playlist.queue.length - 1;
        this.playlist.currentIndex = newIndex;
        await this.play();

        return { success: true, message: 'Now playing' };
      } else {
        // Add to localStorage
        // Parse URL locally
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

        const newItem: PlaylistItem = {
          id: this.generateId(),
          url: url.trim(),
          platform: parsed.platform,
          embedId: parsed.embedId,
          title: metadata.title,
          thumbnail,
          addedAt: new Date().toISOString()
        };

        this.playlist.queue.push(newItem);
        this.playlist.lastUpdated = new Date().toISOString();
        this.saveToLocalStorage();

        // Jump to the newly added item (last in queue) and start playing
        const newIndex = this.playlist.queue.length - 1;
        this.playlist.currentIndex = newIndex;
        await this.play();

        return { success: true, message: 'Now playing' };
      }
    } catch (error: any) {
      console.error('[PlaylistManager] Error adding item:', error);
      return { success: false, error: error.message || 'Failed to add to queue' };
    }
  }

  /**
   * Remove item from queue
   */
  async removeItem(itemId: string): Promise<void> {
    try {
      if (this.isAuthenticated && this.userId) {
        // Remove via API
        await fetch('/api/playlist/remove', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: this.userId, itemId })
        });

        // Reload from server
        await this.loadFromFirebase();
      } else {
        // Remove from localStorage
        const removedIndex = this.playlist.queue.findIndex(item => item.id === itemId);
        this.playlist.queue = this.playlist.queue.filter(item => item.id !== itemId);

        // Adjust currentIndex
        if (removedIndex !== -1 && removedIndex < this.playlist.currentIndex) {
          this.playlist.currentIndex = Math.max(0, this.playlist.currentIndex - 1);
        } else if (removedIndex === this.playlist.currentIndex) {
          // Currently playing item was removed
          if (this.playlist.queue.length > 0) {
            this.playlist.currentIndex = Math.min(this.playlist.currentIndex, this.playlist.queue.length - 1);
            if (this.playlist.isPlaying) {
              await this.playCurrent();
            }
          } else {
            this.playlist.currentIndex = 0;
            this.playlist.isPlaying = false;
            await this.player.destroy();
          }
        }

        this.playlist.lastUpdated = new Date().toISOString();
        this.saveToLocalStorage();
      }

      this.renderUI();
    } catch (error) {
      console.error('[PlaylistManager] Error removing item:', error);
    }
  }

  /**
   * Play playlist
   */
  async play(): Promise<void> {
    if (this.playlist.queue.length === 0) {
      console.warn('[PlaylistManager] Cannot play - queue is empty');
      return;
    }

    this.playlist.isPlaying = true;
    await this.syncState();
    await this.playCurrent();
    this.renderUI();
  }

  /**
   * Pause playlist
   */
  async pause(): Promise<void> {
    this.playlist.isPlaying = false;
    await this.player.pause();
    await this.syncState();
    this.renderUI();
  }

  /**
   * Resume playback
   */
  async resume(): Promise<void> {
    if (this.playlist.queue.length === 0) return;

    this.playlist.isPlaying = true;
    await this.player.play();
    await this.syncState();
    this.renderUI();
  }

  /**
   * Play next track
   */
  async playNext(): Promise<void> {
    if (this.playlist.queue.length === 0) return;

    this.playlist.currentIndex = (this.playlist.currentIndex + 1) % this.playlist.queue.length;
    await this.syncState();
    await this.playCurrent();
    this.renderUI();
  }

  /**
   * Play previous track
   */
  async playPrevious(): Promise<void> {
    if (this.playlist.queue.length === 0) return;

    this.playlist.currentIndex = this.playlist.currentIndex === 0
      ? this.playlist.queue.length - 1
      : this.playlist.currentIndex - 1;

    await this.syncState();
    await this.playCurrent();
    this.renderUI();
  }

  /**
   * Clear entire queue
   */
  async clearQueue(): Promise<void> {
    try {
      if (this.isAuthenticated && this.userId) {
        await fetch('/api/playlist/clear', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: this.userId })
        });
      }

      this.playlist.queue = [];
      this.playlist.currentIndex = 0;
      this.playlist.isPlaying = false;
      this.playlist.lastUpdated = new Date().toISOString();

      await this.player.destroy();
      this.saveToLocalStorage();

      // Disable emojis when queue is cleared
      this.disableEmojis();

      // Show offline overlay again
      const offlineOverlay = document.getElementById('offlineOverlay');
      const videoPlayer = document.getElementById('videoPlayer');
      if (offlineOverlay) {
        offlineOverlay.classList.remove('hidden');
        offlineOverlay.style.display = '';
      }
      if (videoPlayer) {
        videoPlayer.classList.add('hidden');
      }

      this.renderUI();
    } catch (error) {
      console.error('[PlaylistManager] Error clearing queue:', error);
    }
  }

  /**
   * Play current track
   */
  private async playCurrent(): Promise<void> {
    const currentItem = this.playlist.queue[this.playlist.currentIndex];
    if (!currentItem) return;

    try {
      // Directly show the video player and hide overlays
      this.showVideoPlayer();

      // Log to play history
      this.logToHistory(currentItem);

      // Enable emoji reactions
      this.enableEmojis();

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
  private logToHistory(item: PlaylistItem): void {
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
    console.log('[PlaylistManager] History size:', this.playHistory.length);
  }

  /**
   * Enable emoji reactions and audio meters
   */
  private enableEmojis(): void {
    // Enable emoji animations globally
    (window as any).emojiAnimationsEnabled = true;

    // Enable reaction buttons
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

    // Simulate audio activity for LEDs when playlist is playing
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

    // Stop audio LED meters
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

    // Animate LEDs based on simulated audio levels
    this.playlistMeterInterval = window.setInterval(() => {
      if (!this.playlist.isPlaying) {
        this.stopPlaylistMeters();
        return;
      }

      // Generate random levels that look like music (weighted toward middle)
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

    // Clear all LEDs
    document.querySelectorAll('.led-strip .led').forEach(led => led.classList.remove('active'));
    console.log('[PlaylistManager] Audio meters stopped');
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

    // Hide overlays
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

    // Show video player
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
   * Handle track ended
   */
  private async handleTrackEnded(): Promise<void> {
    console.log('[PlaylistManager] Track ended, playing next');
    await this.playNext();
  }

  /**
   * Handle playback error
   */
  private async handlePlaybackError(error: string): Promise<void> {
    console.error('[PlaylistManager] Playback error:', error);
    // Skip to next track on error
    if (this.playlist.queue.length > 1) {
      await this.playNext();
    } else {
      this.playlist.isPlaying = false;
      await this.syncState();
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
   * Load playlist from Firebase
   */
  private async loadFromFirebase(): Promise<void> {
    if (!this.userId) return;

    try {
      const response = await fetch(`/api/playlist/get?userId=${this.userId}`);
      const result = await response.json();

      if (result.success && result.playlist) {
        this.playlist = result.playlist;
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading from Firebase:', error);
      // Fallback to localStorage
      this.loadFromLocalStorage();
    }
  }

  /**
   * Load playlist from localStorage
   */
  private loadFromLocalStorage(): void {
    try {
      const stored = localStorage.getItem(PLAYLIST_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.playlist = {
          ...this.playlist,
          ...parsed,
          isPlaying: false // Don't auto-play on page load
        };
      }
    } catch (error) {
      console.error('[PlaylistManager] Error loading from localStorage:', error);
    }
  }

  /**
   * Sync state to Firebase
   */
  private async syncToFirebase(): Promise<void> {
    if (!this.isAuthenticated || !this.userId) return;

    try {
      await fetch('/api/playlist/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.userId,
          currentIndex: this.playlist.currentIndex,
          isPlaying: this.playlist.isPlaying
        })
      });
    } catch (error) {
      console.error('[PlaylistManager] Error syncing to Firebase:', error);
    }
  }

  /**
   * Save to localStorage
   */
  private saveToLocalStorage(): void {
    try {
      localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(this.playlist));
    } catch (error) {
      console.error('[PlaylistManager] Error saving to localStorage:', error);
    }
  }

  /**
   * Sync state (to both Firebase and localStorage)
   */
  private async syncState(): Promise<void> {
    this.playlist.lastUpdated = new Date().toISOString();
    this.saveToLocalStorage();
    await this.syncToFirebase();
  }

  /**
   * Render UI (to be implemented by UI components)
   */
  private renderUI(): void {
    // Dispatch custom event for UI to update
    const event = new CustomEvent('playlistUpdate', {
      detail: {
        queue: this.playlist.queue,
        currentIndex: this.playlist.currentIndex,
        isPlaying: this.playlist.isPlaying,
        queueSize: this.playlist.queue.length
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
  get queue(): PlaylistItem[] {
    return this.playlist.queue;
  }

  get currentIndex(): number {
    return this.playlist.currentIndex;
  }

  get isPlaying(): boolean {
    return this.playlist.isPlaying;
  }

  get currentItem(): PlaylistItem | null {
    return this.playlist.queue[this.playlist.currentIndex] || null;
  }

  /**
   * Set volume (0-100)
   */
  setVolume(volume: number): void {
    this.player.setVolume(volume);
  }
}
