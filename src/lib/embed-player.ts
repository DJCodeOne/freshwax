// src/lib/embed-player.ts
// Multi-platform embed player manager for YouTube, Vimeo, SoundCloud, and Direct URLs

import type { PlaylistItem, MediaPlatform } from './types';
import { getEmbedUrl } from './url-parser';

export interface PlayerCallbacks {
  onEnded?: () => void;
  onError?: (error: string) => void;
  onReady?: () => void;
  onStateChange?: (state: string) => void;
}

export class EmbedPlayerManager {
  private containerId: string;
  private currentPlatform: MediaPlatform | null = null;
  private youtubePlayer: any = null;
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
          this.callbacks.onReady?.();
        },
        onStateChange: (event: any) => {
          // @ts-ignore
          if (event.data === YT.PlayerState.ENDED) {
            this.callbacks.onEnded?.();
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
          }
        },
        onError: (event: any) => {
          this.callbacks.onError?.('YouTube player error: ' + event.data);
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
  }

  /**
   * Load direct video/audio URL
   */
  private async loadDirect(item: PlaylistItem): Promise<void> {
    const container = document.getElementById(this.containerId);
    if (!container) throw new Error('Container not found');

    // Check if it's HLS (.m3u8)
    const isHLS = item.url.includes('.m3u8');

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
            console.error('[Direct] Autoplay failed:', err);
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
          console.error('[Direct] Autoplay failed:', err);
        });
        this.callbacks.onReady?.();
      } else {
        this.callbacks.onError?.('HLS playback not supported');
        return;
      }
    } else {
      // Regular video formats (mp4, webm, ogg) - no controls
      container.innerHTML = '<video id="direct-video" autoplay style="width: 100%; height: 100%; pointer-events: none;"></video>';
      const video = document.getElementById('direct-video') as HTMLVideoElement;
      this.directVideo = video;

      video.src = item.url;
      video.play().catch((err: any) => {
        console.error('[Direct] Autoplay failed:', err);
      });

      this.callbacks.onReady?.();
    }

    // Add event listeners
    if (this.directVideo) {
      this.directVideo.addEventListener('ended', () => {
        this.callbacks.onEnded?.();
      });

      this.directVideo.addEventListener('error', () => {
        this.callbacks.onError?.('Video playback error');
      });

      this.directVideo.addEventListener('play', () => {
        // Execute pending seek when video first starts playing
        if (this.pendingSeekPosition && !this.hasInitialSeekExecuted && this.directVideo) {
          this.hasInitialSeekExecuted = true;
          const seekPos = this.pendingSeekPosition;
          this.pendingSeekPosition = null;
          console.log('[EmbedPlayerManager] Executing pending seek to:', seekPos, 'seconds');
          this.directVideo.currentTime = seekPos;
        }
        this.callbacks.onStateChange?.('playing');
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
    } catch (error) {
      console.error('[EmbedPlayerManager] Play error:', error);
    }
  }

  /**
   * Pause current media
   */
  async pause(): Promise<void> {
    try {
      if (this.currentPlatform === 'youtube' && this.youtubePlayer) {
        this.youtubePlayer.pauseVideo();
      } else if (this.currentPlatform === 'vimeo' && this.vimeoPlayer) {
        await this.vimeoPlayer.pause();
      } else if (this.currentPlatform === 'soundcloud' && this.soundcloudWidget) {
        this.soundcloudWidget.pause();
      } else if (this.currentPlatform === 'direct' && this.directVideo) {
        this.directVideo.pause();
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
