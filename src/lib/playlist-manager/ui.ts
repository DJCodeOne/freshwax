// src/lib/playlist-manager/ui.ts
// UI/display functions for the playlist manager (meters, emojis, overlays, duration)

import type { GlobalPlaylistItem } from '../types';
import { createClientLogger } from '../client-logger';

const log = createClientLogger('PlaylistUI');

// ============================================
// METER STATE (module-level)
// ============================================

let playlistMeterAnimationId: number | null = null;

const meterState = {
  leftLevel: 0,
  rightLevel: 0,
  targetLeft: 0,
  targetRight: 0,
  beatPhase: 0,
  lastBeatTime: 0,
  bpm: 140 + Math.random() * 40, // Random BPM between 140-180 for D&B feel
};

// ============================================
// ENABLE / DISABLE EMOJIS + CHAT
// ============================================

/**
 * Enable emoji reactions, audio meters, and chat
 */
export function enableEmojis(): void {
  window.emojiAnimationsEnabled = true;

  const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
  reactionButtons.forEach(btn => {
    (btn as HTMLButtonElement).disabled = false;
    btn.classList.remove('disabled', 'reactions-disabled');
  });

  // Hide "Sign in to chat" prompt and show chat input
  const loginPrompt = document.getElementById('loginPrompt');
  if (loginPrompt) {
    loginPrompt.style.display = 'none';
  }

  // Enable chat for playlist mode
  if (typeof window.setChatEnabled === 'function') {
    window.setChatEnabled(true);
  }

  // Setup chat channel for playlist mode if not already done
  if (typeof window.setupChat === 'function' && !window.playlistChatSetup) {
    window.setupChat('playlist-global');
    window.playlistChatSetup = true;
  }

  // Ensure stereo meters are visible for playlist (we use the same LED elements)
  const stereoMeters = document.getElementById('stereoMeters');
  const toggleMetersBtn = document.getElementById('toggleMetersBtn');
  if (stereoMeters) {
    stereoMeters.style.display = '';
  }
  // Hide toggle button since playlist meters are simulated (no audio context to toggle)
  if (toggleMetersBtn) {
    toggleMetersBtn.style.display = 'none';
  }

  startPlaylistMeters();
}

/**
 * Disable emoji reactions, audio meters, and chat (only if no live stream active)
 */
export function disableEmojis(): void {
  // Check if a live stream is active - don't disable anything if so
  const isLiveStreamActive = window.isLiveStreamActive;
  const streamDetectedThisSession = window.streamDetectedThisSession;

  if (isLiveStreamActive || streamDetectedThisSession) {
    return;
  }

  window.emojiAnimationsEnabled = false;

  const reactionButtons = document.querySelectorAll('.reaction-btn, .emoji-btn, [data-reaction], .anim-toggle-btn, .fs-reaction-btn');
  reactionButtons.forEach(btn => {
    (btn as HTMLButtonElement).disabled = true;
    btn.classList.add('disabled', 'reactions-disabled');
  });
  if (!isLiveStreamActive) {
    if (typeof window.setChatEnabled === 'function') {
      window.setChatEnabled(false);
    }

    // Reset playlist chat setup flag
    window.playlistChatSetup = false;
  }

  stopPlaylistMeters();

  // Show the main stereo meters and toggle button again when playlist stops
  const stereoMeters = document.getElementById('stereoMeters');
  const toggleMetersBtn = document.getElementById('toggleMetersBtn');
  if (stereoMeters) {
    stereoMeters.style.display = '';
  }
  if (toggleMetersBtn) {
    toggleMetersBtn.style.display = '';
  }
}

// ============================================
// SIMULATED AUDIO METERS
// ============================================

/**
 * Start simulated audio meters for playlist playback
 * Uses realistic decay, beat sync, and correlated stereo
 */
function startPlaylistMeters(): void {
  if (playlistMeterAnimationId) return;

  const leftLeds = document.querySelectorAll('#leftMeter .led');
  const rightLeds = document.querySelectorAll('#rightMeter .led');

  if (leftLeds.length === 0 || rightLeds.length === 0) return;

  // Reset state
  meterState.leftLevel = 0;
  meterState.rightLevel = 0;
  meterState.lastBeatTime = performance.now();
  meterState.bpm = 140 + Math.random() * 40;

  const updateMeters = () => {
    // Check if animation was cancelled (paused)
    if (!playlistMeterAnimationId) {
      return;
    }

    const now = performance.now();
    const beatInterval = 60000 / meterState.bpm; // ms per beat
    const timeSinceBeat = now - meterState.lastBeatTime;

    // Check for beat hit
    if (timeSinceBeat >= beatInterval) {
      meterState.lastBeatTime = now;
      // Strong beat - push levels up
      const beatStrength = 0.7 + Math.random() * 0.3;
      meterState.targetLeft = 8 + Math.random() * 6 * beatStrength;
      meterState.targetRight = 8 + Math.random() * 6 * beatStrength;

      // Occasional big peak (like a drop or snare hit)
      if (Math.random() < 0.15) {
        meterState.targetLeft = Math.min(14, meterState.targetLeft + 3);
        meterState.targetRight = Math.min(14, meterState.targetRight + 3);
      }
    } else {
      // Between beats - decay with some variation
      const decayProgress = timeSinceBeat / beatInterval;
      const decay = 0.92 - decayProgress * 0.15; // Faster decay as we approach next beat

      meterState.targetLeft *= decay;
      meterState.targetRight *= decay;

      // Add subtle random movement (hi-hats, cymbals)
      if (Math.random() < 0.3) {
        meterState.targetLeft += Math.random() * 2;
        meterState.targetRight += Math.random() * 2;
      }
    }

    // Smooth interpolation toward target (attack/release)
    const attackSpeed = 0.4;
    const releaseSpeed = 0.15;

    if (meterState.targetLeft > meterState.leftLevel) {
      meterState.leftLevel += (meterState.targetLeft - meterState.leftLevel) * attackSpeed;
    } else {
      meterState.leftLevel += (meterState.targetLeft - meterState.leftLevel) * releaseSpeed;
    }

    if (meterState.targetRight > meterState.rightLevel) {
      meterState.rightLevel += (meterState.targetRight - meterState.rightLevel) * attackSpeed;
    } else {
      meterState.rightLevel += (meterState.targetRight - meterState.rightLevel) * releaseSpeed;
    }

    // Add slight stereo difference for realism
    const stereoOffset = (Math.random() - 0.5) * 1.5;
    const leftDisplay = Math.floor(Math.max(0, Math.min(14, meterState.leftLevel + stereoOffset)));
    const rightDisplay = Math.floor(Math.max(0, Math.min(14, meterState.rightLevel - stereoOffset)));

    // Update LED display
    leftLeds.forEach((led, i) => led.classList.toggle('active', i < leftDisplay));
    rightLeds.forEach((led, i) => led.classList.toggle('active', i < rightDisplay));

    playlistMeterAnimationId = requestAnimationFrame(updateMeters);
  };

  playlistMeterAnimationId = requestAnimationFrame(updateMeters);
}

/**
 * Stop simulated audio meters
 */
export function stopPlaylistMeters(): void {
  if (playlistMeterAnimationId) {
    cancelAnimationFrame(playlistMeterAnimationId);
    playlistMeterAnimationId = null;
  }

  // Smooth fade out
  const leftLeds = document.querySelectorAll('#leftMeter .led');
  const rightLeds = document.querySelectorAll('#rightMeter .led');

  leftLeds.forEach(led => led.classList.remove('active'));
  rightLeds.forEach(led => led.classList.remove('active'));

  // Reset state
  meterState.leftLevel = 0;
  meterState.rightLevel = 0;
}

// ============================================
// DURATION / COUNTDOWN DISPLAY
// ============================================

/** Format seconds as MM:SS or H:MM:SS */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Start countdown display using server's trackStartedAt for accuracy.
 * Returns the interval ID so the caller can manage it.
 */
export function startCountdown(
  totalDuration: number,
  trackStartedAt: number | null
): number {
  const bottomDurationEl = document.getElementById('bottomDuration');
  const previewDurationEl = document.getElementById('previewDuration');
  const genreEl = document.getElementById('streamGenre');

  if (genreEl) {
    genreEl.textContent = 'Playlist';
  }

  // Use server trackStartedAt as the authoritative start time.
  // This survives page refreshes -- elapsed = now - serverStart.
  const serverStart = trackStartedAt || Date.now();

  const updateDisplay = () => {
    const elapsedSeconds = (Date.now() - serverStart) / 1000;
    const remaining = Math.max(0, totalDuration - elapsedSeconds);
    const formattedTime = formatDuration(remaining);
    if (bottomDurationEl) bottomDurationEl.textContent = formattedTime;
    if (previewDurationEl) previewDurationEl.textContent = formattedTime;
  };

  updateDisplay();
  return window.setInterval(updateDisplay, 1000);
}

/**
 * Fallback: show elapsed time when duration is unknown.
 * Returns the interval ID so the caller can manage it.
 */
export function startElapsedTimer(trackStartedAt: string | undefined): number {
  const bottomDurationEl = document.getElementById('bottomDuration');
  const previewDurationEl = document.getElementById('previewDuration');

  const serverStartTime = trackStartedAt
    ? new Date(trackStartedAt).getTime()
    : Date.now();

  const updateDisplay = () => {
    const elapsed = Math.floor((Date.now() - serverStartTime) / 1000);
    const formattedTime = formatDuration(elapsed);
    if (bottomDurationEl) bottomDurationEl.textContent = formattedTime;
    if (previewDurationEl) previewDurationEl.textContent = formattedTime;
  };

  updateDisplay();
  return window.setInterval(updateDisplay, 1000);
}

// ============================================
// NOW PLAYING DISPLAY
// ============================================

/**
 * Update NOW PLAYING display at bottom of screen
 */
export function updateNowPlayingDisplay(item: GlobalPlaylistItem | null): void {
  const djNameEl = document.getElementById('controlsDjName');
  const djAvatarEl = document.getElementById('djAvatar') as HTMLImageElement;
  const genreEl = document.getElementById('streamGenre');
  const labelEl = document.querySelector('.dj-info-label');
  const djInfoBar = document.querySelector('.dj-info-bar');

  if (item) {
    // Add playlist mode class for red text styling
    if (djInfoBar) {
      djInfoBar.classList.add('playlist-mode');
    }
    if (djNameEl) {
      djNameEl.textContent = item.title || 'Untitled Video';
    }
    if (labelEl) {
      labelEl.textContent = 'PLAYLIST';
    }
    if (djAvatarEl && item.thumbnail) {
      djAvatarEl.src = item.thumbnail;
    }
    if (genreEl) {
      // Show "Playlist" in genre, countdown goes in duration boxes
      genreEl.textContent = 'Playlist';
    }
  } else {
    // Remove playlist mode class
    if (djInfoBar) {
      djInfoBar.classList.remove('playlist-mode');
    }
    // Only reset DJ name if no live stream is active (preserve relay/DJ name)
    const isLiveStreamActive = window.isLiveStreamActive;
    const streamDetectedThisSession = window.streamDetectedThisSession;
    const currentStreamData = window.currentStreamData;
    if (djNameEl && !isLiveStreamActive && !streamDetectedThisSession && !currentStreamData) {
      djNameEl.textContent = '--';
    }
    if (labelEl) {
      labelEl.textContent = 'NOW PLAYING';
    }
    // Only reset avatar if no live stream is active
    if (djAvatarEl && !isLiveStreamActive && !streamDetectedThisSession && !currentStreamData) {
      djAvatarEl.src = '/place-holder.webp';
    }
    if (genreEl) {
      genreEl.textContent = 'Jungle / D&B';
    }
  }
}

// ============================================
// VIDEO PLAYER / OVERLAY VISIBILITY
// ============================================

/**
 * Show video player and hide overlays.
 * Returns a timeout ID for the safety auto-hide.
 */
export function showVideoPlayer(hideLoadingOverlayFn: () => void): number {
  const offlineOverlay = document.getElementById('offlineOverlay');
  const audioPlayer = document.getElementById('audioPlayer');
  const videoPlayer = document.getElementById('videoPlayer');
  const playlistPlayer = document.getElementById('playlistPlayer');
  const hlsVideo = document.getElementById('hlsVideoElement');

  if (offlineOverlay) {
    offlineOverlay.classList.add('hidden');
    offlineOverlay.style.display = 'none';
  }
  if (audioPlayer) {
    audioPlayer.classList.add('hidden');
  }
  if (hlsVideo) {
    hlsVideo.classList.add('hidden');
  }

  // Show loading overlay while playlist embed loads
  const loadingOverlay = document.getElementById('playlistLoadingOverlay');
  let safetyTimeout = 0;
  if (loadingOverlay) {
    loadingOverlay.classList.remove('hidden', 'fade-out');
    // Safety: auto-hide after 15s in case playing event never fires
    safetyTimeout = window.setTimeout(() => hideLoadingOverlayFn(), 15000);
  }

  if (videoPlayer) {
    videoPlayer.classList.remove('hidden');
    videoPlayer.style.display = 'block';
    videoPlayer.style.opacity = '1';
  }
  if (playlistPlayer) {
    playlistPlayer.classList.remove('hidden');
    playlistPlayer.style.display = 'block';
  }

  return safetyTimeout;
}

/** Hide the playlist loading overlay with a fade */
export function hidePlaylistLoadingOverlay(): void {
  const loadingOverlay = document.getElementById('playlistLoadingOverlay');
  if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
    loadingOverlay.classList.add('fade-out');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
    }, 500);
  }
}

/**
 * Show offline overlay
 */
export function showOfflineOverlay(): void {
  const offlineOverlay = document.getElementById('offlineOverlay');
  const videoPlayer = document.getElementById('videoPlayer');

  if (offlineOverlay) {
    offlineOverlay.classList.remove('hidden');
    offlineOverlay.style.display = '';
  }
  if (videoPlayer) {
    videoPlayer.classList.add('hidden');
  }
}
