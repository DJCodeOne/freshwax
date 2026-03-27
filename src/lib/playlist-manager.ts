// src/lib/playlist-manager.ts
// Thin orchestrator — heavy logic extracted to ./playlist/ sub-modules.
// Class methods delegate to standalone functions in playback.ts, queue.ts, and ui.ts.

import type { GlobalPlaylistItem, GlobalPlaylist } from './types';
import type { EmbedPlayerManager } from './embed-player';
import { createClientLogger } from './client-logger';
import { TIMEOUTS } from './timeouts';
import type { PlaylistHistoryEntry, PersonalPlaylistItem } from './playlist-manager/types';
import { loadRecentlyPlayedFromStorage, loadPlayHistoryFromStorage, savePlayHistoryToStorage, logToHistoryArray } from './playlist-manager/history';
import { loadPersonalPlaylistFromStorage, savePersonalPlaylistToStorage, savePersonalPlaylistToServer, loadPersonalPlaylistFromServer } from './playlist-manager/personal-playlist';
import { enableEmojis, disableEmojis, stopPlaylistMeters, hidePlaylistLoadingOverlay } from './playlist-manager/ui';
import { markAsPlayed, startTrackTimer, clearTrackTimer, calculateSyncPosition, sendControlAction, startAutoPlay as startAutoPlayHelper, handleTrackEnded as handleTrackEndedHelper, handlePlaybackError as handlePlaybackErrorHelper, handlePlayerReady as handlePlayerReadyHelper, handleStateChange as handleStateChangeHelper, handleTitleUpdate as handleTitleUpdateHelper, updateDurationDisplay as updateDurationDisplayHelper, stopCountdown, clearQueue as clearQueueHelper, playCurrent as playCurrentHelper, resumePlayback } from './playlist/playback';
import { addItem as addItemHelper, removeItem as removeItemHelper, subscribeToPusher as subscribeToPusherHelper, handleRemoteUpdate as handleRemoteUpdateHelper, loadFromServer as loadFromServerHelper, addToPersonalPlaylist as addToPersonalPlaylistHelper, removeFromPersonalPlaylist as removeFromPersonalPlaylistHelper, clearPersonalPlaylist as clearPersonalPlaylistHelper } from './playlist/queue';
import { renderPlaylistUI, getUserQueuePosition as getUserQueuePositionHelper, getUserTracksInQueue as getUserTracksInQueueHelper, isUsersTurn as isUsersTurnHelper, getCurrentDj as getCurrentDjHelper } from './playlist/ui';
import type { PlaylistContext } from './playlist/types';

const log = createClientLogger('PlaylistManager');

export class PlaylistManager {
  private userId: string | null = null;
  private userName: string | null = null;
  private playlist: GlobalPlaylist;
  private player: EmbedPlayerManager | null = null;
  private playerPromise: Promise<EmbedPlayerManager> | null = null;
  private isAuthenticated: boolean = false;
  public wasPausedForStream: boolean = false;
  private playHistory: PlaylistHistoryEntry[] = [];
  private personalPlaylist: PersonalPlaylistItem[] = [];
  private pusherChannel: { bind: (event: string, callback: (...args: unknown[]) => void) => void; unbind_all: () => void } | null = null;
  private isSubscribed: boolean = false;
  private trackTimer: number | null = null;
  private recentlyPlayed: Map<string, number> = new Map();
  private globalRecentlyPlayed: Record<string, unknown>[] = [];
  private countdownInterval: number | null = null;
  private countdownTrackId: string | null = null;
  private isFetchingDuration: boolean = false;
  private consecutiveErrors: number = 0;
  private containerId: string;
  private lastPlayedUrl: string | null = null;
  private isPlayingLocked: boolean = false;
  private pendingPlayRequest: boolean = false;
  private isPausedLocally: boolean = false;
  private playbackStartedTime: number = 0;

  constructor(containerId: string) {
    this.containerId = containerId;
    this.playlist = { queue: [], currentIndex: 0, isPlaying: false, lastUpdated: new Date().toISOString() };
    this.playHistory = loadPlayHistoryFromStorage();
    this.recentlyPlayed = loadRecentlyPlayedFromStorage();
    this.personalPlaylist = loadPersonalPlaylistFromStorage();
  }

  private get ctx(): PlaylistContext { return this as unknown as PlaylistContext; }

  private async ensurePlayer(): Promise<EmbedPlayerManager> {
    if (this.player) return this.player;
    if (this.playerPromise) return this.playerPromise;
    this.playerPromise = (async () => {
      const { EmbedPlayerManager: PlayerClass } = await import('./embed-player');
      this.player = new PlayerClass(this.containerId, {
        onEnded: () => this.handleTrackEnded(),
        onError: (error) => this.handlePlaybackError(error),
        onReady: () => handlePlayerReadyHelper(this.ctx),
        onStateChange: (state) => handleStateChangeHelper(this.ctx, state, () => this.renderUI()),
        onTitleUpdate: (title) => handleTitleUpdateHelper(this.ctx, title, () => this.renderUI())
      });
      return this.player;
    })();
    return this.playerPromise;
  }

  async initialize(userId?: string, userName?: string): Promise<void> {
    this.userId = userId || null;
    this.userName = userName || null;
    this.isAuthenticated = !!userId;
    await loadFromServerHelper(this.ctx);
    if (this.isAuthenticated && this.userId) {
      const result = await loadPersonalPlaylistFromServer(this.userId, this.personalPlaylist);
      if (result.changed) {
        this.personalPlaylist = result.items;
        savePersonalPlaylistToStorage(this.personalPlaylist);
        savePersonalPlaylistToServer(this.personalPlaylist, this.userId);
      }
    }
    await subscribeToPusherHelper(this.ctx, (data) => handleRemoteUpdateHelper(this.ctx, data, () => this.playCurrent(), () => this.renderUI()));
    if (this.playlist.queue.length > 0 && this.playlist.isPlaying) {
      await this.playCurrent();
    } else if (this.playlist.queue.length === 0 && !window.isLiveStreamActive) {
      setTimeout(() => startAutoPlayHelper(this.ctx, () => this.playCurrent(), () => this.renderUI()), TIMEOUTS.ANIMATION);
    }
    this.renderUI();
  }

  // Queue operations
  async addItem(url: string) { return addItemHelper(this.ctx, url, () => this.generateId(), () => this.getAuthToken(), (item) => this.logToHistory(item), () => this.playCurrent(), () => this.renderUI()); }
  async removeItem(itemId: string) { return removeItemHelper(this.ctx, itemId, () => this.getAuthToken(), () => this.renderUI()); }

  // Playback controls
  async play(): Promise<void> {
    if (window.isLiveStreamActive || this.playlist.queue.length === 0) return;
    await sendControlAction(this.ctx, 'play', () => this.playCurrent(), () => this.renderUI());
  }
  async pause(): Promise<void> {
    this.isPausedLocally = true;
    clearTrackTimer(this.ctx); stopCountdown(this.ctx);
    if (this.player) await this.player.pause();
    stopPlaylistMeters(); disableEmojis();
  }
  async resume(): Promise<void> { return resumePlayback(this.ctx, () => this.ensurePlayer()); }
  async playNext(): Promise<void> { if (this.playlist.queue.length > 0) await sendControlAction(this.ctx, 'next', () => this.playCurrent(), () => this.renderUI()); }
  async skipTrack(): Promise<void> { if (this.playlist.queue.length > 0) await this.handleTrackEnded(); }
  async startAutoPlay(): Promise<boolean> { return startAutoPlayHelper(this.ctx, () => this.playCurrent(), () => this.renderUI()); }
  async clearQueue(): Promise<void> { return clearQueueHelper(this.ctx, () => this.renderUI()); }

  private async playCurrent(): Promise<void> {
    return playCurrentHelper(this.ctx, () => this.ensurePlayer(), (item) => this.logToHistory(item), () => this.handleTrackEnded(), () => this.renderUI());
  }

  // History
  private logToHistory(item: GlobalPlaylistItem): void { this.playHistory = logToHistoryArray(this.playHistory, item); savePlayHistoryToStorage(this.playHistory); }
  getPlayHistory(): PlaylistHistoryEntry[] { return [...this.playHistory]; }
  clearPlayHistory(): void { this.playHistory = []; savePlayHistoryToStorage(this.playHistory); }

  // Personal playlist
  async addToPersonalPlaylist(url: string, providedTitle?: string, providedThumbnail?: string) { return addToPersonalPlaylistHelper(this.ctx, url, () => this.generateId(), () => this.renderUI(), providedTitle, providedThumbnail); }
  removeFromPersonalPlaylist(itemId: string): void { removeFromPersonalPlaylistHelper(this.ctx, itemId, () => this.renderUI()); }
  async addPersonalItemToQueue(itemId: string) { const item = this.personalPlaylist.find(i => i.id === itemId); if (!item) return { success: false, error: 'Track not found in your playlist' }; return this.addItem(item.url); }
  getPersonalPlaylist(): PersonalPlaylistItem[] { return [...this.personalPlaylist]; }
  clearPersonalPlaylist(): void { clearPersonalPlaylistHelper(this.ctx, () => this.renderUI()); }

  // Event handlers
  private async handleTrackEnded(): Promise<void> { return handleTrackEndedHelper(this.ctx, () => this.playCurrent(), () => this.renderUI()); }
  private async handlePlaybackError(error: string): Promise<void> { return handlePlaybackErrorHelper(this.ctx, error, () => this.handleTrackEnded(), () => this.renderUI()); }

  // Overlays
  public hidePlaylistLoadingOverlay(): void { hidePlaylistLoadingOverlay(); }

  // Render
  private renderUI(): void { renderPlaylistUI(this.ctx); }

  // Utility
  private generateId(): string { return Date.now().toString(36) + Math.random().toString(36).substring(2, 9); }
  private async getAuthToken(): Promise<string | null> { try { const u = window.firebaseAuth?.currentUser; return u ? await u.getIdToken() : null; } catch (_e: unknown) { return null; } }

  // Getters
  get queue(): GlobalPlaylistItem[] { return this.playlist.queue; }
  get currentIndex(): number { return this.playlist.currentIndex; }
  get isPlaying(): boolean { return this.isPausedLocally ? false : this.playlist.isPlaying; }
  get currentItem(): GlobalPlaylistItem | null { return this.playlist.queue[this.playlist.currentIndex] || null; }
  get authenticated(): boolean { return this.isAuthenticated; }
  get isActuallyPlaying(): boolean { return this.player?.isActuallyPlaying() ?? false; }
  setVolume(volume: number): void { this.player?.setVolume(volume); }
  getUserQueuePosition(): number | null { return getUserQueuePositionHelper(this.ctx); }
  getUserTracksInQueue(): number { return getUserTracksInQueueHelper(this.ctx); }
  isUsersTurn(): boolean { return isUsersTurnHelper(this.ctx); }
  getCurrentDj() { return getCurrentDjHelper(this.ctx); }

  // Cleanup
  destroy(): void {
    clearTrackTimer(this.ctx); stopCountdown(this.ctx);
    if (this.pusherChannel) { this.pusherChannel.unbind_all(); const p = window.pusherInstance; if (p) p.unsubscribe('live-playlist'); }
    stopPlaylistMeters(); this.player?.destroy();
  }
}
