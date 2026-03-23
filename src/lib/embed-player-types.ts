// src/lib/embed-player-types.ts
// Type interfaces for embed player SDKs and callbacks

import type { MediaPlatform } from './types';

export interface PlayerCallbacks {
  onEnded?: () => void;
  onError?: (error: string) => void;
  onReady?: () => void;
  onStateChange?: (state: string) => void;
  onTitleUpdate?: (title: string) => void;
}

// Minimal type interfaces for third-party player SDKs (loaded via CDN)
export interface YouTubePlayerInstance {
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

export interface VimeoPlayerInstance {
  destroy: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  setCurrentTime: (seconds: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  getCurrentTime: () => Promise<number>;
  getDuration: () => Promise<number>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
}

export interface SoundCloudWidgetInstance {
  play: () => void;
  pause: () => void;
  seekTo: (ms: number) => void;
  setVolume: (volume: number) => void;
  getPosition: (callback: (position: number) => void) => void;
  getDuration: (callback: (duration: number) => void) => void;
  bind: (event: unknown, callback: (...args: unknown[]) => void) => void;
  unbind: (event: unknown) => void;
}

export type { MediaPlatform };
