// src/lib/embed-player-direct.ts
// Direct media (HTML5 video/audio/HLS) loading helpers for EmbedPlayerManager

import type { PlaylistItem } from './types';
import { escapeHtml } from './escape-html';
import { createClientLogger } from './client-logger';

const log = createClientLogger('EmbedPlayer:Direct');

/**
 * Build the audio player HTML with thumbnail and visual placeholder
 */
export function buildAudioPlayerHTML(thumbnail: string, title: string): string {
  return `
    <div id="audio-container" style="width: 100%; height: 100%; position: relative; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); overflow: hidden;">
      <img id="audio-thumbnail" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(title)}" style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.7; filter: blur(3px) brightness(0.6);" onerror="this.style.display='none'" />
      <div style="position: relative; z-index: 1; text-align: center; padding: 1rem;">
        <img src="${escapeHtml(thumbnail)}" alt="" style="display: block; margin: 0 auto 1rem auto; width: 150px; height: 150px; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 32px rgba(0,0,0,0.4);" onerror="this.outerHTML='<div id=\\'audio-visualizer\\' style=\\'font-size: 4rem; animation: pulse-scale-embed 1.5s ease-in-out infinite;\\'>🎵</div>'" />
        <div id="audio-title" style="color: #fff; font-size: 1rem; font-weight: 600; text-shadow: 0 2px 8px rgba(0,0,0,0.8); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(title)}</div>
        <div style="color: rgba(255,255,255,0.7); font-size: 0.75rem; margin-top: 0.25rem;">Auto-Play</div>
      </div>
      <audio id="direct-audio" autoplay style="display: none;"></audio>
    </div>
    <style>
      @keyframes pulse-scale-embed {
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
}

export interface DirectMediaResult {
  mediaElement: HTMLMediaElement | null;
  error?: string;
}

/**
 * Set up direct media in a container (HLS, audio, or video).
 * Returns the media element for further event binding.
 */
export function setupDirectMedia(
  container: HTMLElement,
  item: PlaylistItem,
  onReady: () => void,
  onError: (msg: string) => void
): DirectMediaResult {
  // Clean up any prior <video>/<audio> that might be left
  const isHLS = item.url.includes('.m3u8');
  const isAudio = /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i.test(item.url);

  if (isHLS) {
    container.innerHTML = '<video id="direct-video" autoplay style="width: 100%; height: 100%; pointer-events: none;"></video>';
    const video = document.getElementById('direct-video') as HTMLVideoElement;

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
        onReady();
      });

      hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
        if (data.fatal) {
          onError('HLS playback error');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = item.url;
      video.play().catch((err: unknown) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          log.error('Autoplay failed:', err);
        }
      });
      onReady();
    } else {
      onError('HLS playback not supported');
      return { mediaElement: null, error: 'HLS not supported' };
    }

    return { mediaElement: video };
  }

  if (isAudio) {
    const thumbnail = item.thumbnail || '/place-holder.webp';
    container.innerHTML = buildAudioPlayerHTML(thumbnail, item.title || 'Audio Track');
    const audio = document.getElementById('direct-audio') as HTMLAudioElement;

    audio.src = item.url;
    audio.play().catch((err: unknown) => {
      if (err instanceof Error && err.name !== 'AbortError') {
        log.error('Audio autoplay failed:', err);
      }
    });

    onReady();
    return { mediaElement: audio };
  }

  // Regular video formats (mp4, webm, ogg)
  container.innerHTML = '<video id="direct-video" autoplay style="width: 100%; height: 100%; pointer-events: none;"></video>';
  const video = document.getElementById('direct-video') as HTMLVideoElement;

  video.src = item.url;
  video.play().catch((err: unknown) => {
    if (err instanceof Error && err.name !== 'AbortError') {
      log.error('Autoplay failed:', err);
    }
  });

  onReady();
  return { mediaElement: video };
}
