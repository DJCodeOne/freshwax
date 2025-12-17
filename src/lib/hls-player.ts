// src/lib/hls-player.ts
// HLS.js Player wrapper for Red5 streams
// Client-side only - import dynamically

import { RED5_CONFIG } from './red5';

export interface HlsPlayerOptions {
  videoElement: HTMLVideoElement;
  hlsUrl: string;
  onStatusChange?: (status: PlayerStatus) => void;
  onError?: (error: string) => void;
  onViewerCount?: (count: number) => void;
  autoplay?: boolean;
  muted?: boolean;
}

export type PlayerStatus = 
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'error'
  | 'ended';

export class HlsStreamPlayer {
  private hls: any = null;
  private video: HTMLVideoElement;
  private hlsUrl: string;
  private status: PlayerStatus = 'idle';
  private retryCount = 0;
  private maxRetries = 5;
  private retryDelay = 3000;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  
  private onStatusChange?: (status: PlayerStatus) => void;
  private onError?: (error: string) => void;
  private onViewerCount?: (count: number) => void;
  
  constructor(options: HlsPlayerOptions) {
    this.video = options.videoElement;
    this.hlsUrl = options.hlsUrl;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
    this.onViewerCount = options.onViewerCount;
    
    // Set video attributes
    this.video.playsInline = true;
    this.video.crossOrigin = 'anonymous';
    
    if (options.muted) {
      this.video.muted = true;
    }
    
    if (options.autoplay) {
      this.video.autoplay = true;
    }
  }
  
  private setStatus(status: PlayerStatus) {
    this.status = status;
    this.onStatusChange?.(status);
  }
  
  async init(): Promise<boolean> {
    // Check if HLS.js is available (loaded via CDN)
    const Hls = (window as any).Hls;
    
    if (!Hls) {
      console.error('[HlsPlayer] HLS.js not loaded');
      this.onError?.('Video player not available');
      return false;
    }
    
    // Check browser support
    if (Hls.isSupported()) {
      return this.initHlsJs(Hls);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari, iOS)
      return this.initNative();
    } else {
      this.onError?.('Your browser does not support HLS playback');
      return false;
    }
  }
  
  private initHlsJs(Hls: any): boolean {
    try {
      this.setStatus('loading');
      
      // HLS.js configuration optimized for reliable, high-quality live streaming
      this.hls = new Hls({
        // Live streaming settings - prioritize stability over low latency
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,

        // Larger buffer for reliable playback without cutting out
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 120 * 1000 * 1000, // 120MB for smoother playback
        maxBufferHole: 0.5,

        // Aggressive error recovery for continuous playback
        fragLoadingMaxRetry: 10,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
        manifestLoadingRetryDelay: 500,
        levelLoadingRetryDelay: 500,

        // ABR settings - prefer higher quality, stable bandwidth estimation
        abrEwmaDefaultEstimate: 1000000, // 1Mbps initial estimate for better quality
        abrBandWidthUpFactor: 0.6,
        abrBandWidthFactor: 0.9,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,

        // Keep more buffer for smooth playback
        backBufferLength: 60,

        // Prefer higher quality levels
        startLevel: -1, // Auto-select best quality
        capLevelToPlayerSize: false,

        // Stall recovery
        nudgeOffset: 0.1,
        nudgeMaxRetry: 5,

        // Debug
        debug: false,
      });
      
      // Error handling
      this.hls.on(Hls.Events.ERROR, (event: any, data: any) => {
        console.warn('[HlsPlayer] HLS error:', data.type, data.details);
        
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.handleNetworkError(data);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.handleMediaError();
              break;
            default:
              this.handleFatalError(data.details);
              break;
          }
        }
      });
      
      // Level loaded - stream is available
      this.hls.on(Hls.Events.LEVEL_LOADED, () => {
        this.retryCount = 0; // Reset retry count on success
      });
      
      // Manifest parsed
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[HlsPlayer] Manifest parsed, attempting playback');
        this.attemptPlay();
      });
      
      // Fragment loaded
      this.hls.on(Hls.Events.FRAG_LOADED, () => {
        if (this.status === 'loading' || this.status === 'buffering') {
          this.setStatus('playing');
        }
      });
      
      // Attach video element and load source
      this.hls.attachMedia(this.video);
      this.hls.loadSource(this.hlsUrl);
      
      // Video element events
      this.setupVideoEvents();
      
      // Start health check
      this.startHealthCheck();
      
      return true;
    } catch (error) {
      console.error('[HlsPlayer] Failed to init HLS.js:', error);
      this.onError?.('Failed to initialize video player');
      return false;
    }
  }
  
  private initNative(): boolean {
    try {
      this.setStatus('loading');
      
      this.video.src = this.hlsUrl;
      this.setupVideoEvents();
      this.attemptPlay();
      
      this.startHealthCheck();
      
      return true;
    } catch (error) {
      console.error('[HlsPlayer] Failed to init native HLS:', error);
      this.onError?.('Failed to initialize video player');
      return false;
    }
  }
  
  private setupVideoEvents() {
    this.video.addEventListener('playing', () => {
      this.setStatus('playing');
      this.retryCount = 0;
    });
    
    this.video.addEventListener('waiting', () => {
      this.setStatus('buffering');
    });
    
    this.video.addEventListener('pause', () => {
      if (this.status !== 'error') {
        this.setStatus('paused');
      }
    });
    
    this.video.addEventListener('ended', () => {
      this.setStatus('ended');
    });
    
    this.video.addEventListener('error', (e) => {
      console.error('[HlsPlayer] Video error:', e);
      this.handleVideoError();
    });
  }
  
  private async attemptPlay() {
    try {
      await this.video.play();
    } catch (error: any) {
      if (error.name === 'NotAllowedError') {
        // Autoplay blocked - mute and try again
        console.log('[HlsPlayer] Autoplay blocked, muting...');
        this.video.muted = true;
        try {
          await this.video.play();
        } catch (e) {
          console.log('[HlsPlayer] Even muted play failed, user interaction needed');
        }
      } else {
        console.error('[HlsPlayer] Play failed:', error);
      }
    }
  }
  
  private handleNetworkError(data: any) {
    console.warn('[HlsPlayer] Network error, attempting recovery...');
    
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      this.setStatus('buffering');
      
      setTimeout(() => {
        if (this.hls) {
          this.hls.startLoad();
        }
      }, this.retryDelay);
    } else {
      this.setStatus('error');
      this.onError?.('Stream unavailable. The DJ may have ended their set.');
    }
  }
  
  private handleMediaError() {
    console.warn('[HlsPlayer] Media error, attempting recovery...');
    
    if (this.hls) {
      this.hls.recoverMediaError();
    }
  }
  
  private handleFatalError(details: string) {
    console.error('[HlsPlayer] Fatal error:', details);
    this.setStatus('error');
    this.onError?.('Playback error. Please try refreshing the page.');
    this.destroy();
  }
  
  private handleVideoError() {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      this.setStatus('buffering');
      
      setTimeout(() => {
        this.video.load();
        this.attemptPlay();
      }, this.retryDelay);
    } else {
      this.setStatus('error');
      this.onError?.('Failed to load stream');
    }
  }
  
  private startHealthCheck() {
    // Periodic check to ensure stream is still alive
    this.healthCheckInterval = setInterval(() => {
      if (this.status === 'playing' && this.video.paused && !this.video.ended) {
        console.log('[HlsPlayer] Stream stalled, attempting recovery...');
        this.attemptPlay();
      }
    }, RED5_CONFIG.timing.healthCheckInterval);
  }
  
  // Public methods
  play() {
    this.attemptPlay();
  }
  
  pause() {
    this.video.pause();
  }
  
  setVolume(volume: number) {
    this.video.volume = Math.max(0, Math.min(1, volume));
  }
  
  mute() {
    this.video.muted = true;
  }
  
  unmute() {
    this.video.muted = false;
  }
  
  getStatus(): PlayerStatus {
    return this.status;
  }
  
  getCurrentTime(): number {
    return this.video.currentTime;
  }
  
  getBuffered(): TimeRanges | null {
    return this.video.buffered;
  }
  
  // Change stream source
  async changeSource(newHlsUrl: string) {
    this.hlsUrl = newHlsUrl;
    this.retryCount = 0;
    
    if (this.hls) {
      this.hls.loadSource(newHlsUrl);
    } else {
      this.video.src = newHlsUrl;
      this.video.load();
      this.attemptPlay();
    }
  }
  
  destroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    
    this.video.src = '';
    this.setStatus('idle');
  }
}

// Factory function for easy instantiation
export function createHlsPlayer(options: HlsPlayerOptions): HlsStreamPlayer {
  return new HlsStreamPlayer(options);
}
