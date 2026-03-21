// src/lib/embed-player.ts
// Multi-platform embed player manager for YouTube, Vimeo, SoundCloud, and Direct URLs

import type { PlaylistItem, MediaPlatform } from './types';
import { escapeHtml } from './escape-html';
import { createClientLogger } from './client-logger';

const log = createClientLogger('EmbedPlayer');

export interface PlayerCallbacks {
  onEnded?: () => void;
  onError?: (error: string) => void;
  onReady?: () => void;
  onStateChange?: (state: string) => void;
  onTitleUpdate?: (title: string) => void;
}

// Minimal type interfaces for third-party player SDKs (loaded via CDN)
interface YouTubePlayerInstance {
  destroy: () => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  getVideoData: () => { title?: string } | undefined;
}

interface VimeoPlayerInstance {
  destroy: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  setCurrentTime: (seconds: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  getCurrentTime: () => Promise<number>;
  getDuration: () => Promise<number>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
}

interface SoundCloudWidgetInstance {
  play: () => void;
  pause: () => void;
  seekTo: (ms: number) => void;
  setVolume: (volume: number) => void;
  getPosition: (callback: (position: number) => void) => void;
  getDuration: (callback: (duration: number) => void) => void;
  bind: (event: unknown, callback: (...args: unknown[]) => void) => void;
  unbind: (event: unknown) => void;
}

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
      // Clean up current player
      await this.cleanup();

      // Reset initial seek flag (but keep pendingSeekPosition if set)
      this.hasInitialSeekExecuted = false;

      // Load the appropriate player
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

    // Load YouTube IFrame API if not loaded
    if (!this.isSDKLoaded.youtube) {
      await this.loadYouTubeSDK();
    }

    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    // Clear container and create player div
    container.innerHTML = '<div id="youtube-player"></div>';

    // Reset ready flag before creating new player
    this.youtubePlayerReady = false;

    this.youtubePlayer = new YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      videoId: item.embedId,
      playerVars: {
        autoplay: 1,
        controls: 0,           // No YouTube controls
        modestbranding: 1,
        rel: 0,
        disablekb: 1,          // Disable keyboard controls
        fs: 0,                 // No fullscreen button
        iv_load_policy: 3,     // No annotations
        showinfo: 0            // No video info
      },
      events: {
        onReady: () => {
          this.youtubePlayerReady = true;
          this.callbacks.onReady?.();
          // Fallback: if pending seek is set, execute it after player is ready
          if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
            const seekPos = this.pendingSeekPosition;
            this.pendingSeekTimeout = setTimeout(() => {
              this.pendingSeekTimeout = null;
              // Double-check we haven't already seeked
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
            // Execute pending seek when video first starts playing
            if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
              this.hasInitialSeekExecuted = true;
              const seekPos = this.pendingSeekPosition;
              this.pendingSeekPosition = null;
              // Small delay to ensure player is truly ready
              setTimeout(() => {
                this.youtubePlayer?.seekTo(seekPos, true);
              }, 100);
            }
            this.callbacks.onStateChange?.('playing');

            // Get video title from YouTube player and emit it
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
          // YouTube error codes:
          // 2: Invalid video ID
          // 5: HTML5 player error
          // 100: Video not found (removed/private)
          // 101: Video owner doesn't allow embedding
          // 150: Same as 101 (embedding not allowed)
          const errorCode = event.data;
          const blockedCodes = [100, 101, 150];
          const isBlocked = blockedCodes.includes(errorCode);

          // Pass structured error info for blocked video handling
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

    // Load Vimeo SDK if not loaded
    if (!this.isSDKLoaded.vimeo) {
      await this.loadVimeoSDK();
    }

    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    // Clear container and create iframe - no controls
    container.innerHTML = `<iframe id="vimeo-player" src="https://player.vimeo.com/video/${escapeHtml(encodeURIComponent(item.embedId))}?autoplay=1&controls=0&keyboard=0" width="100%" height="100%" frameborder="0" allow="autoplay" style="pointer-events: none;"></iframe>`;

    const iframe = document.getElementById('vimeo-player') as HTMLIFrameElement;

    this.vimeoPlayer = new Vimeo.Player(iframe);

    this.vimeoPlayer.on('ended', () => {
      this.callbacks.onEnded?.();
    });

    this.vimeoPlayer.on('error', (error: unknown) => {
      this.callbacks.onError?.('Vimeo player error: ' + (error instanceof Error ? error.message : String(error)));
    });

    this.vimeoPlayer.on('play', async () => {
      // Execute pending seek when video first starts playing
      if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
        this.hasInitialSeekExecuted = true;
        const seekPos = this.pendingSeekPosition;
        this.pendingSeekPosition = null;
        try {
          await this.vimeoPlayer?.setCurrentTime(seekPos);
        } catch (e: unknown) {
          log.warn('Seek error:', e);
        }
      }
      this.callbacks.onStateChange?.('playing');
    });

    this.vimeoPlayer.on('pause', () => {
      this.callbacks.onStateChange?.('paused');
    });

    this.callbacks.onReady?.();
  }

  /**
   * Load SoundCloud player
   */
  private async loadSoundCloud(item: PlaylistItem): Promise<void> {
    if (!item.embedId) throw new Error('Missing SoundCloud track path');

    // Load SoundCloud SDK if not loaded
    if (!this.isSDKLoaded.soundcloud) {
      await this.loadSoundCloudSDK();
    }

    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    const trackUrl = `https://soundcloud.com/${item.embedId}`;
    const embedUrl = `https://w.soundcloud.com/player/?url=${encodeURIComponent(trackUrl)}&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`;

    // Clear container and create iframe
    container.innerHTML = `<iframe id="soundcloud-player" width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="${escapeHtml(embedUrl)}"></iframe>`;

    const iframe = document.getElementById('soundcloud-player') as HTMLIFrameElement;

    this.soundcloudWidget = SC.Widget(iframe);

    if (this.soundcloudWidget) {
      this.soundcloudWidget.bind(SC.Widget.Events.READY, () => {
        this.callbacks.onReady?.();
        this.soundcloudWidget?.play();
      });

      this.soundcloudWidget.bind(SC.Widget.Events.FINISH, () => {
        this.callbacks.onEnded?.();
      });

      this.soundcloudWidget.bind(SC.Widget.Events.ERROR, () => {
        this.callbacks.onError?.('SoundCloud player error');
      });

      this.soundcloudWidget.bind(SC.Widget.Events.PLAY, () => {
        // Execute pending seek when track first starts playing
        if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
          this.hasInitialSeekExecuted = true;
          const seekPos = this.pendingSeekPosition;
          this.pendingSeekPosition = null;
          this.soundcloudWidget?.seekTo(seekPos * 1000); // SoundCloud uses ms
        }
        this.callbacks.onStateChange?.('playing');
      });

      this.soundcloudWidget.bind(SC.Widget.Events.PAUSE, () => {
        this.callbacks.onStateChange?.('paused');
      });
    }
  }

  /**
   * Load direct video/audio URL
   */
  private async loadDirect(item: PlaylistItem): Promise<void> {
    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    // Clean up old directVideo to prevent stale error listeners
    if (this.directVideo) {
      this.directVideo.pause();
      this.directVideo.src = '';
      this.directVideo.load(); // Reset the element
      this.directVideo = null;
    }

    // Check if it's HLS (.m3u8)
    const isHLS = item.url.includes('.m3u8');
    // Check if it's audio-only (MP3, etc)
    const isAudio = /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i.test(item.url);

    if (isHLS) {
      // Use HLS.js for HLS streams - no controls
      container.innerHTML = '<video id="direct-video" autoplay style="width: 100%; height: 100%; pointer-events: none;"></video>';
      const video = document.getElementById('direct-video') as HTMLVideoElement;
      this.directVideo = video;

      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90
        });

        hls.loadSource(item.url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch((err: unknown) => {
            if (err instanceof Error && err.name !== 'AbortError') {
              log.error('Autoplay failed:', err);
            }
          });
          this.callbacks.onReady?.();
        });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
          if (data.fatal) {
            this.callbacks.onError?.('HLS playback error');
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = item.url;
        video.play().catch((err: unknown) => {
          if (err instanceof Error && err.name !== 'AbortError') {
            log.error('Autoplay failed:', err);
          }
        });
        this.callbacks.onReady?.();
      } else {
        this.callbacks.onError?.('HLS playback not supported');
        return;
      }
    } else if (isAudio) {
      // Audio files (MP3, WAV, etc) - use audio element with thumbnail or visual placeholder
      const thumbnail = item.thumbnail || '/place-holder.webp';
      container.innerHTML = `
        <div id="audio-container" style="width: 100%; height: 100%; position: relative; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); overflow: hidden;">
          <img id="audio-thumbnail" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(item.title || 'Audio Track')}" style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.7; filter: blur(3px) brightness(0.6);" onerror="this.style.display='none'" />
          <div style="position: relative; z-index: 1; text-align: center; padding: 1rem;">
            <img src="${escapeHtml(thumbnail)}" alt="" style="display: block; margin: 0 auto 1rem auto; width: 150px; height: 150px; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 32px rgba(0,0,0,0.4);" onerror="this.outerHTML='<div id=\\'audio-visualizer\\' style=\\'font-size: 4rem; animation: pulse 1.5s ease-in-out infinite;\\'>🎵</div>'" />
            <div id="audio-title" style="color: #fff; font-size: 1rem; font-weight: 600; text-shadow: 0 2px 8px rgba(0,0,0,0.8); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.title || 'Audio Track')}</div>
            <div style="color: rgba(255,255,255,0.7); font-size: 0.75rem; margin-top: 0.25rem;">Auto-Play</div>
          </div>
          <audio id="direct-audio" autoplay style="display: none;"></audio>
        </div>
        <style>
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
          }
          @media (prefers-reduced-motion: reduce) {
            * {
              animation-duration: 0.01ms !important;
              animation-iteration-count: 1 !important;
              transition-duration: 0.01ms !important;
            }
          }
        </style>
      `;
      const audio = document.getElementById('direct-audio') as HTMLAudioElement;
      // Use the same property name for consistency
      this.directVideo = audio;

      audio.src = item.url;
      audio.play().catch((err: unknown) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          log.error('Audio autoplay failed:', err);
        }
      });

      this.callbacks.onReady?.();
    } else {
      // Regular video formats (mp4, webm, ogg) - no controls
      container.innerHTML = '<video id="direct-video" autoplay style="width: 100%; height: 100%; pointer-events: none;"></video>';
      const video = document.getElementById('direct-video') as HTMLVideoElement;
      this.directVideo = video;

      video.src = item.url;
      video.play().catch((err: unknown) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          log.error('Autoplay failed:', err);
        }
      });

      this.callbacks.onReady?.();
    }

    // Add event listeners
    if (this.directVideo) {
      this.directVideo.addEventListener('ended', () => {
        this.callbacks.onEnded?.();
      });

      this.directVideo.addEventListener('error', (e) => {
        const target = e.target as HTMLMediaElement;
        const mediaError = target?.error;

        // Ignore errors for empty src (happens during cleanup)
        if (!target?.src || target.src === '' || target.src === window.location.href) {
          return;
        }

        const errorDetails = mediaError
          ? `Media playback error (code ${mediaError.code}): ${mediaError.message}`
          : 'Media playback error (unknown)';
        log.error('Direct media error:', errorDetails);
        this.callbacks.onError?.(errorDetails);
      });

      this.directVideo.addEventListener('play', () => {
        // Execute pending seek when media first starts playing
        if (this.pendingSeekPosition && !this.hasInitialSeekExecuted && this.directVideo) {
          this.hasInitialSeekExecuted = true;
          const seekPos = this.pendingSeekPosition;
          this.pendingSeekPosition = null;
          this.directVideo.currentTime = seekPos;
        }
        this.callbacks.onStateChange?.('playing');
      });

      this.directVideo.addEventListener('pause', () => {
        this.callbacks.onStateChange?.('paused');
      });
    }
  }

  /**
   * Play current media
   */
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
      // AbortError happens when play() is interrupted by pause() - this is expected during rapid state changes
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      log.error('Play error:', error);
    }
  }

  /**
   * Pause current media
   */
  async pause(): Promise<void> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        // Check if pauseVideo function exists
        if (typeof this.youtubePlayer.pauseVideo === 'function') {
          const stateBefore = typeof this.youtubePlayer.getPlayerState === 'function'
            ? this.youtubePlayer.getPlayerState()
            : 'unknown';
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

  /**
   * Set volume (0-100)
   */
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

  /**
   * Seek to position in seconds (for sync)
   */
  async seekTo(seconds: number): Promise<void> {
    try {
      const position = Math.max(0, seconds);

      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        // YouTube: seekTo(seconds, allowSeekAhead)
        this.youtubePlayer.seekTo(position, true);
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        // Vimeo: setCurrentTime(seconds)
        await this.vimeoPlayer.setCurrentTime(position);
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        // SoundCloud: seekTo(milliseconds)
        this.soundcloudWidget.seekTo(position * 1000);
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        // HTML5 video: currentTime in seconds
        this.directVideo.currentTime = position;
      }
    } catch (error: unknown) {
      log.error('Seek error:', error);
    }
  }

  /**
   * Get current playback position in seconds
   */
  async getCurrentTime(): Promise<number> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        return this.youtubePlayer.getCurrentTime() || 0;
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        return await this.vimeoPlayer.getCurrentTime() || 0;
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        return new Promise((resolve) => {
          this.soundcloudWidget.getPosition((position: number) => {
            resolve(position / 1000); // Convert ms to seconds
          });
        });
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        return this.directVideo.currentTime || 0;
      }
    } catch (error: unknown) {
      log.error('GetCurrentTime error:', error);
    }
    return 0;
  }

  /**
   * Get total duration in seconds
   */
  async getDuration(): Promise<number> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        return this.youtubePlayer.getDuration() || 0;
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        return await this.vimeoPlayer.getDuration() || 0;
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        return new Promise((resolve) => {
          this.soundcloudWidget.getDuration((duration: number) => {
            resolve(duration / 1000); // Convert ms to seconds
          });
        });
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        const duration = this.directVideo.duration;
        // Check for NaN or Infinity (streams)
        if (isNaN(duration) || !isFinite(duration)) {
          return 0;
        }
        return duration;
      }
    } catch (error: unknown) {
      log.error('GetDuration error:', error);
    }
    return 0;
  }

  /**
   * Wait for audio/video metadata to load (for getting accurate duration)
   * Returns a promise that resolves with duration once metadata is available
   */
  waitForMetadata(timeoutMs: number = 10000): Promise<number> {
    return new Promise((resolve) => {
      if (this.currentPlatform !== 'direct' || !this.directVideo) {
        // For non-direct platforms, just use getDuration
        this.getDuration().then(resolve);
        return;
      }

      const media = this.directVideo;

      // If metadata already loaded
      if (media.readyState >= 1 && !isNaN(media.duration) && isFinite(media.duration) && media.duration > 0) {
        resolve(media.duration);
        return;
      }

      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          log.warn('Metadata timeout after', timeoutMs, 'ms');
          resolve(0);
        }
      }, timeoutMs);

      const onMetadataLoaded = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        media.removeEventListener('loadedmetadata', onMetadataLoaded);
        media.removeEventListener('durationchange', onDurationChange);
        const duration = media.duration;
        if (!isNaN(duration) && isFinite(duration) && duration > 0) {
          resolve(duration);
        } else {
          log.warn('Metadata loaded but duration invalid:', duration);
          resolve(0);
        }
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

  /**
   * Check if media is actually playing (not paused/blocked)
   */
  isActuallyPlaying(): boolean {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        // YouTube player states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 video cued
        const state = this.youtubePlayer.getPlayerState?.();
        return state === 1; // 1 = playing
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        return !this.directVideo.paused && this.directVideo.readyState >= 2;
      }
      // For Vimeo and SoundCloud, we'd need async calls - return false as fallback
      return false;
    } catch (error: unknown) {
      log.error('isActuallyPlaying error:', error);
      return false;
    }
  }

  /**
   * Clean up current player
   */
  private async cleanup(): Promise<void> {
    if (this.pendingSeekTimeout) {
      clearTimeout(this.pendingSeekTimeout);
      this.pendingSeekTimeout = null;
    }

    if (this.youtubePlayer) {
      try {
        this.youtubePlayer.destroy();
      } catch (e: unknown) {
        log.warn('Cleanup error:', e);
      }
      this.youtubePlayer = null;
    }

    if (this.vimeoPlayer) {
      try {
        await this.vimeoPlayer.destroy();
      } catch (e: unknown) {
        log.warn('Cleanup error:', e);
      }
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
      } catch (e: unknown) {
        log.warn('Cleanup error:', e);
      }
      this.soundcloudWidget = null;
    }

    if (this.directVideo) {
      this.directVideo.pause();
      this.directVideo.src = '';
      this.directVideo = null;
    }

    const container = document.getElementById(this.containerId);
    if (container) {
      container.innerHTML = '';
    }
  }

  /**
   * Load YouTube IFrame API
   */
  private loadYouTubeSDK(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isSDKLoaded.youtube) {
        resolve();
        return;
      }

      if (typeof YT !== 'undefined' && YT.Player) {
        this.isSDKLoaded.youtube = true;
        resolve();
        return;
      }

      window.onYouTubeIframeAPIReady = () => {
        this.isSDKLoaded.youtube = true;
        resolve();
      };

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => reject(new Error('Failed to load YouTube SDK'));
      document.head.appendChild(script);
    });
  }

  /**
   * Load Vimeo Player SDK
   */
  private loadVimeoSDK(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isSDKLoaded.vimeo) {
        resolve();
        return;
      }

      if (typeof Vimeo !== 'undefined' && Vimeo.Player) {
        this.isSDKLoaded.vimeo = true;
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://player.vimeo.com/api/player.js';
      script.onload = () => {
        this.isSDKLoaded.vimeo = true;
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load Vimeo SDK'));
      document.head.appendChild(script);
    });
  }

  /**
   * Load SoundCloud Widget API
   */
  private loadSoundCloudSDK(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isSDKLoaded.soundcloud) {
        resolve();
        return;
      }

      if (typeof SC !== 'undefined' && SC.Widget) {
        this.isSDKLoaded.soundcloud = true;
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://w.soundcloud.com/player/api.js';
      script.onload = () => {
        this.isSDKLoaded.soundcloud = true;
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load SoundCloud SDK'));
      document.head.appendChild(script);
    });
  }

  /**
   * Destroy player and clean up resources
   */
  async destroy(): Promise<void> {
    await this.cleanup();
    this.currentPlatform = null;
  }
}
