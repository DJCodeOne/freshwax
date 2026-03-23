// src/lib/embed-player.ts
// Multi-platform embed player manager for YouTube, Vimeo, SoundCloud, and Direct URLs

import type { PlaylistItem } from './types';
import { escapeHtml } from './escape-html';
import { TIMEOUTS } from './timeouts';
import { createClientLogger } from './client-logger';
import { loadYouTubeSDK, loadVimeoSDK, loadSoundCloudSDK } from './embed-player-sdk';
import { setupDirectMedia } from './embed-player-direct';
import type {
  PlayerCallbacks,
  YouTubePlayerInstance,
  VimeoPlayerInstance,
  SoundCloudWidgetInstance,
  MediaPlatform,
} from './embed-player-types';

// Re-export for consumers
export type { PlayerCallbacks } from './embed-player-types';

const log = createClientLogger('EmbedPlayer');

export class EmbedPlayerManager {
  private containerId: string;
  private currentPlatform: MediaPlatform | null = null;
  private youtubePlayer: YouTubePlayerInstance | null = null;
  private youtubePlayerReady: boolean = false;
  private vimeoPlayer: VimeoPlayerInstance | null = null;
  private soundcloudWidget: SoundCloudWidgetInstance | null = null;
  private directVideo: HTMLMediaElement | null = null;
  private callbacks: PlayerCallbacks;
  private isSDKLoaded: { [key: string]: boolean } = {
    youtube: false,
    vimeo: false,
    soundcloud: false
  };
  private pendingSeekPosition: number | null = null;
  private hasInitialSeekExecuted: boolean = false;
  private pendingSeekTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(containerId: string, callbacks: PlayerCallbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks;
  }

  /**
   * Set a pending seek position to be executed when player starts playing
   */
  setPendingSeek(seconds: number): void {
    this.pendingSeekPosition = seconds > 2 ? seconds : null;
    this.hasInitialSeekExecuted = false;
  }

  /**
   * Load and play a playlist item
   */
  async loadItem(item: PlaylistItem): Promise<void> {
    try {
      await this.cleanup();
      this.hasInitialSeekExecuted = false;

      switch (item.platform) {
        case 'youtube':
          await this.loadYouTube(item);
          break;
        case 'vimeo':
          await this.loadVimeo(item);
          break;
        case 'soundcloud':
          await this.loadSoundCloud(item);
          break;
        case 'direct':
          await this.loadDirect(item);
          break;
        default:
          throw new Error(`Unsupported platform: ${item.platform}`);
      }

      this.currentPlatform = item.platform;
    } catch (error: unknown) {
      log.error('Error loading item:', error);
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Failed to load media');
    }
  }

  /**
   * Load YouTube player
   */
  private async loadYouTube(item: PlaylistItem): Promise<void> {
    if (!item.embedId) throw new Error('Missing YouTube video ID');

    if (!this.isSDKLoaded.youtube) {
      await loadYouTubeSDK(this.isSDKLoaded);
    }

    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    container.innerHTML = '<div id="youtube-player"></div>';
    this.youtubePlayerReady = false;

    this.youtubePlayer = new YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      videoId: item.embedId,
      playerVars: {
        autoplay: 1,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        showinfo: 0
      },
      events: {
        onReady: () => {
          this.youtubePlayerReady = true;
          this.callbacks.onReady?.();
          if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
            const seekPos = this.pendingSeekPosition;
            this.pendingSeekTimeout = setTimeout(() => {
              this.pendingSeekTimeout = null;
              if (!this.hasInitialSeekExecuted && this.youtubePlayer) {
                this.hasInitialSeekExecuted = true;
                this.pendingSeekPosition = null;
                this.youtubePlayer.seekTo(seekPos, true);
              }
            }, 500);
          }
        },
        onStateChange: (event: { data: number }) => {
          if (event.data === YT.PlayerState.ENDED) {
            this.callbacks.onEnded?.();
          }
          if (event.data === YT.PlayerState.PAUSED) {
            this.callbacks.onStateChange?.('paused');
          }
          if (event.data === YT.PlayerState.PLAYING) {
            if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
              this.hasInitialSeekExecuted = true;
              const seekPos = this.pendingSeekPosition;
              this.pendingSeekPosition = null;
              setTimeout(() => {
                this.youtubePlayer?.seekTo(seekPos, true);
              }, 100);
            }
            this.callbacks.onStateChange?.('playing');

            try {
              const videoData = this.youtubePlayer?.getVideoData?.();
              if (videoData?.title) {
                this.callbacks.onTitleUpdate?.(videoData.title);
              }
            } catch (e: unknown) {
              // Ignore errors getting video data
            }
          }
        },
        onError: (event: { data: number }) => {
          const errorCode = event.data;
          const blockedCodes = [100, 101, 150];
          const isBlocked = blockedCodes.includes(errorCode);

          this.callbacks.onError?.(JSON.stringify({
            type: isBlocked ? 'blocked' : 'error',
            code: errorCode,
            message: isBlocked
              ? 'Video unavailable or blocked'
              : `YouTube player error: ${errorCode}`
          }));
        }
      }
    });
  }

  /**
   * Load Vimeo player
   */
  private async loadVimeo(item: PlaylistItem): Promise<void> {
    if (!item.embedId) throw new Error('Missing Vimeo video ID');

    if (!this.isSDKLoaded.vimeo) {
      await loadVimeoSDK(this.isSDKLoaded);
    }

    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    container.innerHTML = `<iframe id="vimeo-player" src="https://player.vimeo.com/video/${escapeHtml(encodeURIComponent(item.embedId))}?autoplay=1&controls=0&keyboard=0" width="100%" height="100%" frameborder="0" allow="autoplay" style="pointer-events: none;"></iframe>`;

    const iframe = document.getElementById('vimeo-player') as HTMLIFrameElement;
    this.vimeoPlayer = new Vimeo.Player(iframe);

    this.vimeoPlayer.on('ended', () => { this.callbacks.onEnded?.(); });
    this.vimeoPlayer.on('error', (error: unknown) => {
      this.callbacks.onError?.('Vimeo player error: ' + (error instanceof Error ? error.message : String(error)));
    });
    this.vimeoPlayer.on('play', async () => {
      if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
        this.hasInitialSeekExecuted = true;
        const seekPos = this.pendingSeekPosition;
        this.pendingSeekPosition = null;
        try { await this.vimeoPlayer?.setCurrentTime(seekPos); } catch (e: unknown) { log.warn('Seek error:', e); }
      }
      this.callbacks.onStateChange?.('playing');
    });
    this.vimeoPlayer.on('pause', () => { this.callbacks.onStateChange?.('paused'); });
    this.callbacks.onReady?.();
  }

  /**
   * Load SoundCloud player
   */
  private async loadSoundCloud(item: PlaylistItem): Promise<void> {
    if (!item.embedId) throw new Error('Missing SoundCloud track path');

    if (!this.isSDKLoaded.soundcloud) {
      await loadSoundCloudSDK(this.isSDKLoaded);
    }

    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    const trackUrl = `https://soundcloud.com/${item.embedId}`;
    const embedUrl = `https://w.soundcloud.com/player/?url=${encodeURIComponent(trackUrl)}&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`;
    container.innerHTML = `<iframe id="soundcloud-player" width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="${escapeHtml(embedUrl)}"></iframe>`;

    const iframe = document.getElementById('soundcloud-player') as HTMLIFrameElement;
    this.soundcloudWidget = SC.Widget(iframe);

    if (this.soundcloudWidget) {
      this.soundcloudWidget.bind(SC.Widget.Events.READY, () => { this.callbacks.onReady?.(); this.soundcloudWidget?.play(); });
      this.soundcloudWidget.bind(SC.Widget.Events.FINISH, () => { this.callbacks.onEnded?.(); });
      this.soundcloudWidget.bind(SC.Widget.Events.ERROR, () => { this.callbacks.onError?.('SoundCloud player error'); });
      this.soundcloudWidget.bind(SC.Widget.Events.PLAY, () => {
        if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
          this.hasInitialSeekExecuted = true;
          const seekPos = this.pendingSeekPosition;
          this.pendingSeekPosition = null;
          this.soundcloudWidget?.seekTo(seekPos * 1000);
        }
        this.callbacks.onStateChange?.('playing');
      });
      this.soundcloudWidget.bind(SC.Widget.Events.PAUSE, () => { this.callbacks.onStateChange?.('paused'); });
    }
  }

  /**
   * Load direct video/audio URL — delegates to embed-player-direct.ts
   */
  private async loadDirect(item: PlaylistItem): Promise<void> {
    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    // Clean up old directVideo to prevent stale error listeners
    if (this.directVideo) {
      this.directVideo.pause();
      this.directVideo.src = '';
      this.directVideo.load();
      this.directVideo = null;
    }

    const { mediaElement } = setupDirectMedia(
      container,
      item,
      () => this.callbacks.onReady?.(),
      (msg) => this.callbacks.onError?.(msg)
    );

    this.directVideo = mediaElement;

    // Add event listeners for seek, state changes, and errors
    if (this.directVideo) {
      this.directVideo.addEventListener('ended', () => { this.callbacks.onEnded?.(); });
      this.directVideo.addEventListener('error', (e) => {
        const target = e.target as HTMLMediaElement;
        const mediaError = target?.error;
        if (!target?.src || target.src === '' || target.src === window.location.href) return;
        const errorDetails = mediaError
          ? `Media playback error (code ${mediaError.code}): ${mediaError.message}`
          : 'Media playback error (unknown)';
        log.error('Direct media error:', errorDetails);
        this.callbacks.onError?.(errorDetails);
      });
      this.directVideo.addEventListener('play', () => {
        if (this.pendingSeekPosition && !this.hasInitialSeekExecuted && this.directVideo) {
          this.hasInitialSeekExecuted = true;
          const seekPos = this.pendingSeekPosition;
          this.pendingSeekPosition = null;
          this.directVideo.currentTime = seekPos;
        }
        this.callbacks.onStateChange?.('playing');
      });
      this.directVideo.addEventListener('pause', () => { this.callbacks.onStateChange?.('paused'); });
    }
  }

  async play(): Promise<void> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        this.youtubePlayer.playVideo();
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        await this.vimeoPlayer.play();
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.play();
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        await this.directVideo.play();
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      log.error('Play error:', error);
    }
  }

  async pause(): Promise<void> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        if (typeof this.youtubePlayer.pauseVideo === 'function') {
          this.youtubePlayer.pauseVideo();
        } else {
          log.error('pauseVideo is not a function on youtubePlayer');
        }
      } else if (this.currentPlatform === 'youtube' && !this.youtubePlayerReady) {
        log.warn('YouTube player not ready yet, cannot pause');
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        await this.vimeoPlayer.pause();
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.pause();
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        this.directVideo.pause();
      } else {
        log.warn('No player available to pause');
      }
    } catch (error: unknown) {
      log.error('Pause error:', error);
    }
  }

  setVolume(volume: number): void {
    try {
      const normalizedVolume = Math.max(0, Math.min(100, volume));
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        this.youtubePlayer.setVolume(normalizedVolume);
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        this.vimeoPlayer.setVolume(normalizedVolume / 100);
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.setVolume(normalizedVolume);
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        this.directVideo.volume = normalizedVolume / 100;
      }
    } catch (error: unknown) {
      log.error('Volume error:', error);
    }
  }

  async seekTo(seconds: number): Promise<void> {
    try {
      const position = Math.max(0, seconds);
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        this.youtubePlayer.seekTo(position, true);
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        await this.vimeoPlayer.setCurrentTime(position);
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.seekTo(position * 1000);
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        this.directVideo.currentTime = position;
      }
    } catch (error: unknown) {
      log.error('Seek error:', error);
    }
  }

  async getCurrentTime(): Promise<number> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        return this.youtubePlayer.getCurrentTime() || 0;
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        return await this.vimeoPlayer.getCurrentTime() || 0;
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        return new Promise((resolve) => {
          this.soundcloudWidget.getPosition((position: number) => { resolve(position / 1000); });
        });
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        return this.directVideo.currentTime || 0;
      }
    } catch (error: unknown) {
      log.error('GetCurrentTime error:', error);
    }
    return 0;
  }

  async getDuration(): Promise<number> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        return this.youtubePlayer.getDuration() || 0;
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        return await this.vimeoPlayer.getDuration() || 0;
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        return new Promise((resolve) => {
          this.soundcloudWidget.getDuration((duration: number) => { resolve(duration / 1000); });
        });
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        const duration = this.directVideo.duration;
        if (isNaN(duration) || !isFinite(duration)) return 0;
        return duration;
      }
    } catch (error: unknown) {
      log.error('GetDuration error:', error);
    }
    return 0;
  }

  waitForMetadata(timeoutMs: number = TIMEOUTS.API): Promise<number> {
    return new Promise((resolve) => {
      if (this.currentPlatform !== 'direct' || !this.directVideo) {
        this.getDuration().then(resolve);
        return;
      }

      const media = this.directVideo;
      if (media.readyState >= 1 && !isNaN(media.duration) && isFinite(media.duration) && media.duration > 0) {
        resolve(media.duration);
        return;
      }

      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) { resolved = true; log.warn('Metadata timeout after', timeoutMs, 'ms'); resolve(0); }
      }, timeoutMs);

      const onMetadataLoaded = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        media.removeEventListener('loadedmetadata', onMetadataLoaded);
        media.removeEventListener('durationchange', onDurationChange);
        const duration = media.duration;
        if (!isNaN(duration) && isFinite(duration) && duration > 0) { resolve(duration); }
        else { log.warn('Metadata loaded but duration invalid:', duration); resolve(0); }
      };

      const onDurationChange = () => {
        if (resolved) return;
        const duration = media.duration;
        if (!isNaN(duration) && isFinite(duration) && duration > 0) {
          resolved = true;
          clearTimeout(timeoutId);
          media.removeEventListener('loadedmetadata', onMetadataLoaded);
          media.removeEventListener('durationchange', onDurationChange);
          resolve(duration);
        }
      };

      media.addEventListener('loadedmetadata', onMetadataLoaded);
      media.addEventListener('durationchange', onDurationChange);
    });
  }

  isActuallyPlaying(): boolean {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        const state = this.youtubePlayer.getPlayerState?.();
        return state === 1;
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        return !this.directVideo.paused && this.directVideo.readyState >= 2;
      }
      return false;
    } catch (error: unknown) {
      log.error('isActuallyPlaying error:', error);
      return false;
    }
  }

  private async cleanup(): Promise<void> {
    if (this.pendingSeekTimeout) { clearTimeout(this.pendingSeekTimeout); this.pendingSeekTimeout = null; }
    if (this.youtubePlayer) {
      try { this.youtubePlayer.destroy(); } catch (e: unknown) { log.warn('Cleanup error:', e); }
      this.youtubePlayer = null;
    }
    if (this.vimeoPlayer) {
      try { await this.vimeoPlayer.destroy(); } catch (e: unknown) { log.warn('Cleanup error:', e); }
      this.vimeoPlayer = null;
    }
    if (this.soundcloudWidget) {
      try {
        if (typeof SC !== 'undefined' && SC.Widget?.Events) {
          this.soundcloudWidget.unbind(SC.Widget.Events.READY);
          this.soundcloudWidget.unbind(SC.Widget.Events.FINISH);
          this.soundcloudWidget.unbind(SC.Widget.Events.ERROR);
          this.soundcloudWidget.unbind(SC.Widget.Events.PLAY);
        }
      } catch (e: unknown) { log.warn('Cleanup error:', e); }
      this.soundcloudWidget = null;
    }
    if (this.directVideo) { this.directVideo.pause(); this.directVideo.src = ''; this.directVideo = null; }
    const container = document.getElementById(this.containerId);
    if (container) { container.innerHTML = ''; }
  }

  async destroy(): Promise<void> {
    await this.cleanup();
    this.currentPlatform = null;
  }
}
