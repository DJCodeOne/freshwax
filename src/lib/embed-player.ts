// src/lib/embed-player.ts
// Multi-platform embed player manager for YouTube, Vimeo, SoundCloud, and Direct URLs

import type { PlaylistItem, MediaPlatform } from './types';
import { getEmbedUrl } from './url-parser';

export interface PlayerCallbacks {
  onEnded?: () => void;
  onError?: (error: string) => void;
  onReady?: () => void;
  onStateChange?: (state: string) => void;
  onTitleUpdate?: (title: string) => void;
}

export class EmbedPlayerManager {
  private containerId: string;
  private currentPlatform: MediaPlatform | null = null;
  private youtubePlayer: any = null;
  private youtubePlayerReady: boolean = false;
  private vimeoPlayer: any = null;
  private soundcloudWidget: any = null;
  private directVideo: HTMLVideoElement | null = null;
  private callbacks: PlayerCallbacks;
  private isSDKLoaded: { [key: string]: boolean } = {
    youtube: false,
    vimeo: false,
    soundcloud: false
  };
  private pendingSeekPosition: number | null = null;
  private hasInitialSeekExecuted: boolean = false;

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
    if (this.pendingSeekPosition) {
      console.log('[EmbedPlayerManager] Pending seek set to:', seconds, 'seconds');
    }
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
    } catch (error: any) {
      console.error('[EmbedPlayerManager] Error loading item:', error);
      this.callbacks.onError?.(error.message || 'Failed to load media');
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

    // @ts-ignore - YouTube API global
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
          console.log('[EmbedPlayerManager] YouTube player ready');
          this.callbacks.onReady?.();
          // Fallback: if pending seek is set, execute it after player is ready
          if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
            const seekPos = this.pendingSeekPosition;
            console.log('[EmbedPlayerManager] onReady: Will seek to', seekPos, 'seconds after delay');
            setTimeout(() => {
              // Double-check we haven't already seeked
              if (!this.hasInitialSeekExecuted && this.youtubePlayer) {
                this.hasInitialSeekExecuted = true;
                this.pendingSeekPosition = null;
                console.log('[EmbedPlayerManager] onReady fallback: Seeking to', seekPos, 'seconds');
                this.youtubePlayer.seekTo(seekPos, true);
              }
            }, 500);
          }
        },
        onStateChange: (event: any) => {
          // @ts-ignore
          if (event.data === YT.PlayerState.ENDED) {
            this.callbacks.onEnded?.();
          }
          // @ts-ignore
          if (event.data === YT.PlayerState.PAUSED) {
            console.log('[EmbedPlayerManager] YouTube player paused');
            this.callbacks.onStateChange?.('paused');
          }
          // @ts-ignore
          if (event.data === YT.PlayerState.PLAYING) {
            // Execute pending seek when video first starts playing
            if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
              this.hasInitialSeekExecuted = true;
              const seekPos = this.pendingSeekPosition;
              this.pendingSeekPosition = null;
              console.log('[EmbedPlayerManager] Executing pending seek to:', seekPos, 'seconds');
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
                console.log('[EmbedPlayerManager] Got YouTube title:', videoData.title);
                this.callbacks.onTitleUpdate?.(videoData.title);
              }
            } catch (e) {
              // Ignore errors getting video data
            }
          }
        },
        onError: (event: any) => {
          // YouTube error codes:
          // 2: Invalid video ID
          // 5: HTML5 player error
          // 100: Video not found (removed/private)
          // 101: Video owner doesn't allow embedding
          // 150: Same as 101 (embedding not allowed)
          const errorCode = event.data;
          const blockedCodes = [100, 101, 150];
          const isBlocked = blockedCodes.includes(errorCode);

          console.log('[EmbedPlayerManager] YouTube error code:', errorCode, 'isBlocked:', isBlocked);

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
    container.innerHTML = `<iframe id="vimeo-player" src="https://player.vimeo.com/video/${item.embedId}?autoplay=1&controls=0&keyboard=0" width="100%" height="100%" frameborder="0" allow="autoplay" style="pointer-events: none;"></iframe>`;

    const iframe = document.getElementById('vimeo-player') as HTMLIFrameElement;

    // @ts-ignore - Vimeo Player global
    this.vimeoPlayer = new Vimeo.Player(iframe);

    this.vimeoPlayer.on('ended', () => {
      this.callbacks.onEnded?.();
    });

    this.vimeoPlayer.on('error', (error: any) => {
      this.callbacks.onError?.('Vimeo player error: ' + error.message);
    });

    this.vimeoPlayer.on('play', async () => {
      // Execute pending seek when video first starts playing
      if (this.pendingSeekPosition && !this.hasInitialSeekExecuted) {
        this.hasInitialSeekExecuted = true;
        const seekPos = this.pendingSeekPosition;
        this.pendingSeekPosition = null;
        console.log('[EmbedPlayerManager] Executing pending seek to:', seekPos, 'seconds');
        try {
          await this.vimeoPlayer?.setCurrentTime(seekPos);
        } catch (e) {
          console.warn('[Vimeo] Seek error:', e);
        }
      }
      this.callbacks.onStateChange?.('playing');
    });

    this.vimeoPlayer.on('pause', () => {
      console.log('[EmbedPlayerManager] Vimeo player paused');
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
    container.innerHTML = `<iframe id="soundcloud-player" width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="${embedUrl}"></iframe>`;

    const iframe = document.getElementById('soundcloud-player') as HTMLIFrameElement;

    // @ts-ignore - SoundCloud Widget API global
    this.soundcloudWidget = SC.Widget(iframe);

    this.soundcloudWidget.bind(SC.Widget.Events.READY, () => {
      this.callbacks.onReady?.();
      this.soundcloudWidget.play();
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
        console.log('[EmbedPlayerManager] Executing pending seek to:', seekPos, 'seconds');
        this.soundcloudWidget?.seekTo(seekPos * 1000); // SoundCloud uses ms
      }
      this.callbacks.onStateChange?.('playing');
    });

    this.soundcloudWidget.bind(SC.Widget.Events.PAUSE, () => {
      console.log('[EmbedPlayerManager] SoundCloud player paused');
      this.callbacks.onStateChange?.('paused');
    });
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

      // @ts-ignore - HLS.js will be loaded via script tag in page
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        // @ts-ignore
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90
        });

        hls.loadSource(item.url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch((err: any) => {
            if (err?.name !== 'AbortError') {
              console.error('[Direct] Autoplay failed:', err);
            }
          });
          this.callbacks.onReady?.();
        });

        hls.on(Hls.Events.ERROR, (event: any, data: any) => {
          if (data.fatal) {
            this.callbacks.onError?.('HLS playback error');
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = item.url;
        video.play().catch((err: any) => {
          if (err?.name !== 'AbortError') {
            console.error('[Direct] Autoplay failed:', err);
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
          <img id="audio-thumbnail" src="${thumbnail}" alt="${item.title || 'Audio Track'}" style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.7; filter: blur(3px) brightness(0.6);" onerror="this.style.display='none'" />
          <div style="position: relative; z-index: 1; text-align: center; padding: 1rem;">
            <img src="${thumbnail}" alt="" style="display: block; margin: 0 auto 1rem auto; width: 150px; height: 150px; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 32px rgba(0,0,0,0.4);" onerror="this.outerHTML='<div id=\\'audio-visualizer\\' style=\\'font-size: 4rem; animation: pulse 1.5s ease-in-out infinite;\\'>🎵</div>'" />
            <div id="audio-title" style="color: #fff; font-size: 1rem; font-weight: 600; text-shadow: 0 2px 8px rgba(0,0,0,0.8); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.title || 'Audio Track'}</div>
            <div style="color: rgba(255,255,255,0.7); font-size: 0.75rem; margin-top: 0.25rem;">Auto-Play</div>
          </div>
          <audio id="direct-audio" autoplay style="display: none;"></audio>
        </div>
        <style>
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
          }
        </style>
      `;
      const audio = document.getElementById('direct-audio') as HTMLAudioElement;
      // Use the same property name for consistency
      this.directVideo = audio as any;

      audio.src = item.url;
      audio.play().catch((err: any) => {
        if (err?.name !== 'AbortError') {
          console.error('[Direct] Audio autoplay failed:', err);
        }
      });

      this.callbacks.onReady?.();
    } else {
      // Regular video formats (mp4, webm, ogg) - no controls
      container.innerHTML = '<video id="direct-video" autoplay style="width: 100%; height: 100%; pointer-events: none;"></video>';
      const video = document.getElementById('direct-video') as HTMLVideoElement;
      this.directVideo = video;

      video.src = item.url;
      video.play().catch((err: any) => {
        if (err?.name !== 'AbortError') {
          console.error('[Direct] Autoplay failed:', err);
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
          console.log('[EmbedPlayerManager] Ignoring error for empty/cleared src');
          return;
        }

        const errorDetails = mediaError
          ? `Media playback error (code ${mediaError.code}): ${mediaError.message}`
          : 'Media playback error (unknown)';
        console.error('[EmbedPlayerManager] Direct media error:', errorDetails);
        this.callbacks.onError?.(errorDetails);
      });

      this.directVideo.addEventListener('play', () => {
        // Execute pending seek when media first starts playing
        if (this.pendingSeekPosition && !this.hasInitialSeekExecuted && this.directVideo) {
          this.hasInitialSeekExecuted = true;
          const seekPos = this.pendingSeekPosition;
          this.pendingSeekPosition = null;
          console.log('[EmbedPlayerManager] Executing pending seek to:', seekPos, 'seconds');
          this.directVideo.currentTime = seekPos;
        }
        this.callbacks.onStateChange?.('playing');
      });

      this.directVideo.addEventListener('pause', () => {
        console.log('[EmbedPlayerManager] Direct media paused');
        this.callbacks.onStateChange?.('paused');
      });
    }
  }

  /**
   * Play current media
   */
  async play(): Promise<void> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer) {
        this.youtubePlayer.playVideo();
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        await this.vimeoPlayer.play();
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.play();
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        await this.directVideo.play();
      }
    } catch (error: any) {
      // AbortError happens when play() is interrupted by pause() - this is expected during rapid state changes
      if (error?.name === 'AbortError') {
        console.log('[EmbedPlayerManager] Play interrupted (normal during state changes)');
        return;
      }
      console.error('[EmbedPlayerManager] Play error:', error);
    }
  }

  /**
   * Pause current media
   */
  async pause(): Promise<void> {
    console.log('[EmbedPlayerManager] Pause called, platform:', this.currentPlatform, 'hasPlayer:', !!this.youtubePlayer, 'ready:', this.youtubePlayerReady);
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer && this.youtubePlayerReady) {
        // Check if pauseVideo function exists
        if (typeof this.youtubePlayer.pauseVideo === 'function') {
          const stateBefore = typeof this.youtubePlayer.getPlayerState === 'function'
            ? this.youtubePlayer.getPlayerState()
            : 'unknown';
          console.log('[EmbedPlayerManager] YouTube player state before pause:', stateBefore);
          this.youtubePlayer.pauseVideo();
          console.log('[EmbedPlayerManager] pauseVideo() called successfully');
        } else {
          console.error('[EmbedPlayerManager] pauseVideo is not a function on youtubePlayer');
        }
      } else if (this.currentPlatform === 'youtube' && !this.youtubePlayerReady) {
        console.warn('[EmbedPlayerManager] YouTube player not ready yet, cannot pause');
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        await this.vimeoPlayer.pause();
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.pause();
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        this.directVideo.pause();
      } else {
        console.warn('[EmbedPlayerManager] No player available to pause');
      }
    } catch (error) {
      console.error('[EmbedPlayerManager] Pause error:', error);
    }
  }

  /**
   * Set volume (0-100)
   */
  setVolume(volume: number): void {
    try {
      const normalizedVolume = Math.max(0, Math.min(100, volume));

      if (this.currentPlatform === 'youtube' && this.youtubePlayer) {
        this.youtubePlayer.setVolume(normalizedVolume);
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        this.vimeoPlayer.setVolume(normalizedVolume / 100);
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.setVolume(normalizedVolume);
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        this.directVideo.volume = normalizedVolume / 100;
      }
    } catch (error) {
      console.error('[EmbedPlayerManager] Volume error:', error);
    }
  }

  /**
   * Seek to position in seconds (for sync)
   */
  async seekTo(seconds: number): Promise<void> {
    try {
      const position = Math.max(0, seconds);
      console.log('[EmbedPlayerManager] Seeking to:', position, 'seconds');

      if (this.currentPlatform === 'youtube' && this.youtubePlayer) {
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
    } catch (error) {
      console.error('[EmbedPlayerManager] Seek error:', error);
    }
  }

  /**
   * Get current playback position in seconds
   */
  async getCurrentTime(): Promise<number> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer) {
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
    } catch (error) {
      console.error('[EmbedPlayerManager] GetCurrentTime error:', error);
    }
    return 0;
  }

  /**
   * Get total duration in seconds
   */
  async getDuration(): Promise<number> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer) {
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
        return this.directVideo.duration || 0;
      }
    } catch (error) {
      console.error('[EmbedPlayerManager] GetDuration error:', error);
    }
    return 0;
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
    } catch (error) {
      console.error('[EmbedPlayerManager] isActuallyPlaying error:', error);
      return false;
    }
  }

  /**
   * Clean up current player
   */
  private async cleanup(): Promise<void> {
    if (this.youtubePlayer) {
      try {
        this.youtubePlayer.destroy();
      } catch (e) {
        console.warn('[YouTube] Cleanup error:', e);
      }
      this.youtubePlayer = null;
    }

    if (this.vimeoPlayer) {
      try {
        await this.vimeoPlayer.destroy();
      } catch (e) {
        console.warn('[Vimeo] Cleanup error:', e);
      }
      this.vimeoPlayer = null;
    }

    if (this.soundcloudWidget) {
      try {
        this.soundcloudWidget.unbind(SC.Widget.Events.READY);
        this.soundcloudWidget.unbind(SC.Widget.Events.FINISH);
        this.soundcloudWidget.unbind(SC.Widget.Events.ERROR);
        this.soundcloudWidget.unbind(SC.Widget.Events.PLAY);
      } catch (e) {
        console.warn('[SoundCloud] Cleanup error:', e);
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

      // @ts-ignore
      if (typeof YT !== 'undefined' && YT.Player) {
        this.isSDKLoaded.youtube = true;
        resolve();
        return;
      }

      // @ts-ignore
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

      // @ts-ignore
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

      // @ts-ignore
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
