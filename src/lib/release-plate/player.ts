/**
 * Release plate player — tracklist preview with clip restriction (90s starting at 60s).
 */
import { createClientLogger } from '../client-logger';

const log = createClientLogger('ReleasePlate');

// Clip restriction constants
const CLIP_START_TIME = 60;
const CLIP_DURATION = 90;
const CLIP_END_TIME = CLIP_START_TIME + CLIP_DURATION;
const FADE_DURATION = 3;
const FADE_OUT_START = CLIP_END_TIME - FADE_DURATION;

declare function showToast(msg: string): void;

export function initReleasePlayer() {
  document.querySelectorAll('[data-release]').forEach(function(releaseCard) {
    if (releaseCard.hasAttribute('data-player-init')) return;
    releaseCard.setAttribute('data-player-init', 'true');

    const releaseId = releaseCard.getAttribute('data-release');
    if (!releaseId) return;

    const canvas = releaseCard.querySelector('.shared-waveform[data-release-id="' + releaseId + '"]') as HTMLCanvasElement | null;
    const volumeSlider = releaseCard.querySelector('.shared-volume-slider[data-release-id="' + releaseId + '"]') as HTMLInputElement | null;
    const nowPlayingText = releaseCard.querySelector('[data-now-playing-text="' + releaseId + '"]');
    const playButtons = releaseCard.querySelectorAll('.play-button');

    let currentAudio: HTMLAudioElement | null = null;
    let currentButton: Element | null = null;
    let currentVolume = 0.7;
    let ctx: CanvasRenderingContext2D | null = null;
    const bars = 60;
    let barWidth = 0;

    if (canvas) {
      ctx = canvas.getContext('2d');
      const container = canvas.parentElement;
      const containerWidth = container ? container.offsetWidth : 400;
      canvas.width = Math.min(containerWidth, 400);
      canvas.height = 50;
      barWidth = (canvas.width / bars) - 1;
      drawWaveform(0, false);

      canvas.onclick = function(e) {
        if (!currentAudio || !currentAudio.duration || !isFinite(currentAudio.duration)) return;
        const rect = canvas!.getBoundingClientRect();
        const progress = (e.clientX - rect.left) / rect.width;
        const seekTime = CLIP_START_TIME + (progress * CLIP_DURATION);
        currentAudio.currentTime = Math.min(Math.max(seekTime, CLIP_START_TIME), CLIP_END_TIME - 1);
      };
    }

    function drawWaveform(progress: number, isPlaying: boolean) {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < bars; i++) {
        const height = (Math.random() * 0.5 + 0.3) * canvas.height;
        const x = i * (barWidth + 1);
        const y = (canvas.height - height) / 2;
        ctx.fillStyle = isPlaying ? (i / bars < progress ? '#dc2626' : '#ffffff') : (i / bars < progress ? '#dc2626' : '#4b5563');
        ctx.fillRect(x, y, barWidth, height);
      }
    }

    if (volumeSlider) {
      volumeSlider.oninput = function() {
        currentVolume = parseInt(volumeSlider!.value) / 100;
        if (currentAudio) currentAudio.volume = currentVolume;
      };
    }

    playButtons.forEach(function(button) {
      const trackId = button.getAttribute('data-track-id');
      const previewUrl = button.getAttribute('data-preview-url');
      const trackTitle = button.getAttribute('data-track-title') || 'Unknown Track';
      const playIcon = button.querySelector('.play-icon');
      const pauseIcon = button.querySelector('.pause-icon');

      (button as HTMLElement).onclick = function() {
        if (!previewUrl) {
          alert('Preview not available for this track');
          if (nowPlayingText) nowPlayingText.textContent = 'Preview not available';
          return;
        }

        let audio = releaseCard.querySelector('.track-audio[data-track-id="' + trackId + '"]') as HTMLAudioElement | null;

        if (!audio) {
          audio = document.createElement('audio');
          audio.className = 'hidden track-audio';
          audio.setAttribute('data-track-id', trackId || '');
          audio.setAttribute('data-release-id', releaseId || '');
          audio.preload = 'none';
          audio.src = previewUrl;
          audio.volume = currentVolume;
          releaseCard.appendChild(audio);

          audio.ontimeupdate = function() {
            if (audio === currentAudio && audio!.duration && isFinite(audio!.duration)) {
              const currentTime = audio!.currentTime;

              if (currentTime >= CLIP_END_TIME) {
                audio!.pause();
                audio!.volume = currentVolume;
                audio!.currentTime = CLIP_START_TIME;
                button.classList.remove('playing');
                if (playIcon) playIcon.classList.remove('hidden');
                if (pauseIcon) pauseIcon.classList.add('hidden');
                if (nowPlayingText) nowPlayingText.textContent = '90s preview ended';
                drawWaveform(0, false);
                showToast('90 second preview ended');
                if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
                return;
              }

              if (currentTime >= CLIP_START_TIME && currentTime < CLIP_START_TIME + FADE_DURATION) {
                const fadeInProgress = (currentTime - CLIP_START_TIME) / FADE_DURATION;
                audio!.volume = currentVolume * fadeInProgress;
              } else if (currentTime >= FADE_OUT_START) {
                const fadeOutProgress = (CLIP_END_TIME - currentTime) / FADE_DURATION;
                audio!.volume = currentVolume * Math.max(0, fadeOutProgress);
              } else {
                audio!.volume = currentVolume;
              }

              const clipProgress = (currentTime - CLIP_START_TIME) / CLIP_DURATION;
              drawWaveform(Math.max(0, Math.min(1, clipProgress)), !audio!.paused);
            }
          };

          audio.onloadedmetadata = function() {
            if (audio!.duration > CLIP_START_TIME) {
              audio!.currentTime = CLIP_START_TIME;
            }
          };

          audio.onended = function() {
            button.classList.remove('playing');
            if (playIcon) playIcon.classList.remove('hidden');
            if (pauseIcon) pauseIcon.classList.add('hidden');
            if (nowPlayingText) nowPlayingText.textContent = 'Track ended';
            drawWaveform(0, false);
            if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
          };

          audio.onerror = function() {
            button.classList.remove('playing');
            if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
          };
        }

        if (currentAudio === audio && !audio.paused) {
          audio.pause();
          button.classList.remove('playing');
          if (playIcon) playIcon.classList.remove('hidden');
          if (pauseIcon) pauseIcon.classList.add('hidden');
          if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
          return;
        }

        if (window.AudioManager) window.AudioManager.onTracklistPreviewPlay(audio);

        releaseCard.querySelectorAll('.track-audio').forEach(function(a) {
          if (a !== audio && !(a as HTMLAudioElement).paused) {
            (a as HTMLAudioElement).pause();
            (a as HTMLAudioElement).currentTime = 0;
          }
        });

        document.querySelectorAll('[data-release]').forEach(function(otherCard) {
          if (otherCard !== releaseCard) {
            otherCard.querySelectorAll('.track-audio').forEach(function(a) {
              if (!(a as HTMLAudioElement).paused) {
                (a as HTMLAudioElement).pause();
                (a as HTMLAudioElement).currentTime = 0;
              }
            });
            otherCard.querySelectorAll('.play-button').forEach(function(btn) {
              btn.classList.remove('playing');
              const pi = btn.querySelector('.play-icon');
              const pa = btn.querySelector('.pause-icon');
              if (pi) pi.classList.remove('hidden');
              if (pa) pa.classList.add('hidden');
            });
            const otherNowPlaying = otherCard.querySelector('[data-now-playing-text]');
            if (otherNowPlaying) otherNowPlaying.textContent = 'No track selected';
          }
        });

        playButtons.forEach(function(btn) {
          btn.classList.remove('playing');
          const pi = btn.querySelector('.play-icon');
          const pa = btn.querySelector('.pause-icon');
          if (pi) pi.classList.remove('hidden');
          if (pa) pa.classList.add('hidden');
        });

        currentAudio = audio;
        currentButton = button;

        if (audio.duration && audio.duration > CLIP_START_TIME) {
          if (audio.currentTime < CLIP_START_TIME || audio.currentTime >= CLIP_END_TIME) {
            audio.currentTime = CLIP_START_TIME;
            audio.volume = 0;
          }
        } else {
          audio.volume = 0;
        }

        audio.play().then(function() {
          button.classList.add('playing');
          if (playIcon) playIcon.classList.add('hidden');
          if (pauseIcon) pauseIcon.classList.remove('hidden');
          if (nowPlayingText) nowPlayingText.textContent = trackTitle;
          showToast('Playing 90 second preview');
        }).catch(function(err: unknown) {
          audio!.volume = currentVolume;
          alert('Could not play preview. The file may be unavailable.');
          if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
        });
      };
    });
  });
}
