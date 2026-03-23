// src/lib/embed-player-sdk.ts
// SDK loader functions for YouTube, Vimeo, and SoundCloud player APIs

/**
 * Load YouTube IFrame API
 */
export function loadYouTubeSDK(isSDKLoaded: Record<string, boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isSDKLoaded.youtube) {
      resolve();
      return;
    }

    if (typeof YT !== 'undefined' && YT.Player) {
      isSDKLoaded.youtube = true;
      resolve();
      return;
    }

    window.onYouTubeIframeAPIReady = () => {
      isSDKLoaded.youtube = true;
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
export function loadVimeoSDK(isSDKLoaded: Record<string, boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isSDKLoaded.vimeo) {
      resolve();
      return;
    }

    if (typeof Vimeo !== 'undefined' && Vimeo.Player) {
      isSDKLoaded.vimeo = true;
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://player.vimeo.com/api/player.js';
    script.onload = () => {
      isSDKLoaded.vimeo = true;
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load Vimeo SDK'));
    document.head.appendChild(script);
  });
}

/**
 * Load SoundCloud Widget API
 */
export function loadSoundCloudSDK(isSDKLoaded: Record<string, boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isSDKLoaded.soundcloud) {
      resolve();
      return;
    }

    if (typeof SC !== 'undefined' && SC.Widget) {
      isSDKLoaded.soundcloud = true;
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://w.soundcloud.com/player/api.js';
    script.onload = () => {
      isSDKLoaded.soundcloud = true;
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load SoundCloud SDK'));
    document.head.appendChild(script);
  });
}
