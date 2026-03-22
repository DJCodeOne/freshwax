/**
 * Release plate player — tracklist preview with clip restriction (90s starting at 60s).
 */
import { createClientLogger } from '../client-logger';

const log = createClientLogger('ReleasePlate');

// Clip restriction constants
var CLIP_START_TIME = 60;
var CLIP_DURATION = 90;
var CLIP_END_TIME = CLIP_START_TIME + CLIP_DURATION;
var FADE_DURATION = 3;
var FADE_OUT_START = CLIP_END_TIME - FADE_DURATION;

declare function showToast(msg: string): void;

export function initReleasePlayer() {
  document.querySelectorAll('[data-release]').forEach(function(releaseCard) {
    if (releaseCard.hasAttribute('data-player-init')) return;
    releaseCard.setAttribute('data-player-init', 'true');

    var releaseId = releaseCard.getAttribute('data-release');
    if (!releaseId) return;

    var canvas = releaseCard.querySelector('.shared-waveform[data-release-id="' + releaseId + '"]') as HTMLCanvasElement | null;
    var volumeSlider = releaseCard.querySelector('.shared-volume-slider[data-release-id="' + releaseId + '"]') as HTMLInputElement | null;
    var nowPlayingText = releaseCard.querySelector('[data-now-playing-text="' + releaseId + '"]');
    var playButtons = releaseCard.querySelectorAll('.play-button');

    var currentAudio: HTMLAudioElement | null = null;
    var currentButton: Element | null = null;
    var currentVolume = 0.7;
    var ctx: CanvasRenderingContext2D | null = null;
    var bars = 60;
    var barWidth = 0;

    if (canvas) {
      ctx = canvas.getContext('2d');
      var container = canvas.parentElement;
      var containerWidth = container ? container.offsetWidth : 400;
      canvas.width = Math.min(containerWidth, 400);
      canvas.height = 50;
      barWidth = (canvas.width / bars) - 1;
      drawWaveform(0, false);

      canvas.onclick = function(e) {
        if (!currentAudio || !currentAudio.duration || !isFinite(currentAudio.duration)) return;
        var rect = canvas!.getBoundingClientRect();
        var progress = (e.clientX - rect.left) / rect.width;
        var seekTime = CLIP_START_TIME + (progress * CLIP_DURATION);
        currentAudio.currentTime = Math.min(Math.max(seekTime, CLIP_START_TIME), CLIP_END_TIME - 1);
      };
    }

    function drawWaveform(progress: number, isPlaying: boolean) {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < bars; i++) {
        var height = (Math.random() * 0.5 + 0.3) * canvas.height;
        var x = i * (barWidth + 1);
        var y = (canvas.height - height) / 2;
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
      var trackId = button.getAttribute('data-track-id');
      var previewUrl = button.getAttribute('data-preview-url');
      var trackTitle = button.getAttribute('data-track-title') || 'Unknown Track';
      var playIcon = button.querySelector('.play-icon');
      var pauseIcon = button.querySelector('.pause-icon');

      (button as HTMLElement).onclick = function() {
        if (!previewUrl) {
          alert('Preview not available for this track');
          if (nowPlayingText) nowPlayingText.textContent = 'Preview not available';
          return;
        }

        var audio = releaseCard.querySelector('.track-audio[data-track-id="' + trackId + '"]') as HTMLAudioElement | null;

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
              var currentTime = audio!.currentTime;

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
                if ((window as any).AudioManager) (window as any).AudioManager.onTracklistPreviewStop(audio);
                return;
              }

              if (currentTime >= CLIP_START_TIME && currentTime < CLIP_START_TIME + FADE_DURATION) {
                var fadeInProgress = (currentTime - CLIP_START_TIME) / FADE_DURATION;
                audio!.volume = currentVolume * fadeInProgress;
              } else if (currentTime >= FADE_OUT_START) {
                var fadeOutProgress = (CLIP_END_TIME - currentTime) / FADE_DURATION;
                audio!.volume = currentVolume * Math.max(0, fadeOutProgress);
              } else {
                audio!.volume = currentVolume;
              }

              var clipProgress = (currentTime - CLIP_START_TIME) / CLIP_DURATION;
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
            if ((window as any).AudioManager) (window as any).AudioManager.onTracklistPreviewStop(audio);
          };

          audio.onerror = function() {
            button.classList.remove('playing');
            if ((window as any).AudioManager) (window as any).AudioManager.onTracklistPreviewStop(audio);
          };
        }

        if (currentAudio === audio && !audio.paused) {
          audio.pause();
          button.classList.remove('playing');
          if (playIcon) playIcon.classList.remove('hidden');
          if (pauseIcon) pauseIcon.classList.add('hidden');
          if ((window as any).AudioManager) (window as any).AudioManager.onTracklistPreviewStop(audio);
          return;
        }

        if ((window as any).AudioManager) (window as any).AudioManager.onTracklistPreviewPlay(audio);

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
              var pi = btn.querySelector('.play-icon');
              var pa = btn.querySelector('.pause-icon');
              if (pi) pi.classList.remove('hidden');
              if (pa) pa.classList.add('hidden');
            });
            var otherNowPlaying = otherCard.querySelector('[data-now-playing-text]');
            if (otherNowPlaying) otherNowPlaying.textContent = 'No track selected';
          }
        });

        playButtons.forEach(function(btn) {
          btn.classList.remove('playing');
          var pi = btn.querySelector('.play-icon');
          var pa = btn.querySelector('.pause-icon');
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
          if ((window as any).AudioManager) (window as any).AudioManager.onTracklistPreviewStop(audio);
        });
      };
    });
  });
}
