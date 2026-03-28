// src/lib/playlist-modal/dom-state.ts
// DOM update functions that depend on ModalState (auth UI, position, now playing,
// video preview, recently-played timers, clipboard).

import { TIMEOUTS } from '../timeouts';
import type { PlaylistItem, ModalState } from './types';
import { isPlaceholderTitle, getYouTubeId, formatTimeAgo } from './dom-format';

// ---------------------------------------------------------------------------
// DOM update functions (depend on state)
// ---------------------------------------------------------------------------

/** Update UI based on authentication state */
export function updateAuthUI(state: ModalState): void {
  const authNotice = document.getElementById('playlistAuthNotice');
  const inputGroup = document.getElementById('playlistInputGroup');

  if (state.isAuthenticated) {
    if (authNotice) {
      authNotice.classList.add('hidden');
      authNotice.style.display = 'none';
    }
    if (inputGroup) {
      inputGroup.classList.remove('hidden');
      inputGroup.style.display = '';
    }
  } else {
    if (authNotice) {
      authNotice.classList.remove('hidden');
      authNotice.style.display = '';
    }
    if (inputGroup) {
      inputGroup.classList.add('hidden');
      inputGroup.style.display = 'none';
    }
  }
}

/** Update position indicator based on user's queue position */
export function updatePositionIndicator(
  state: ModalState,
  position: number | null,
  isUsersTurn: boolean,
  _queueSize: number,
): void {
  const indicator = document.getElementById('positionIndicator');
  const positionText = document.getElementById('positionText');
  const yourTrackIndicator = document.getElementById('yourTrackIndicator');

  if (!indicator || !positionText) return;

  indicator.classList.add('hidden');
  indicator.classList.remove('your-turn');
  yourTrackIndicator?.classList.add('hidden');

  if (!state.isAuthenticated || position === null) {
    return;
  }

  if (isUsersTurn) {
    yourTrackIndicator?.classList.remove('hidden');
    return;
  }

  indicator.classList.remove('hidden');
  const waitingCount = position - 1;
  if (waitingCount === 0) {
    positionText.textContent = 'You are up next!';
  } else if (waitingCount === 1) {
    positionText.textContent = 'Your track is next, locked and loaded!';
  } else {
    positionText.textContent = `You are #${position} - ${waitingCount} DJs ahead of you`;
  }
}

/** Update Now Playing Strip */
export function updateNowPlayingStrip(
  queue: PlaylistItem[],
  currentIndex: number,
  currentDj: Record<string, unknown> | null,
  trackStartedAt: string | null | undefined,
  updateVideoPreviewFn: (item: PlaylistItem | null, dj: Record<string, unknown> | null, started?: string | null) => void,
): void {
  const strip = document.getElementById('nowPlayingStrip');
  const title = document.getElementById('nowPlayingTitle');

  if (!strip || !title) return;

  if (queue.length === 0 || currentIndex >= queue.length) {
    strip.classList.add('hidden');
    updateVideoPreviewFn(null, null, null);
    return;
  }

  const currentItem = queue[currentIndex];
  strip.classList.remove('hidden');
  title.textContent = currentItem?.title || 'Unknown Track';

  updateVideoPreviewFn(currentItem, currentDj, trackStartedAt);
}

/** Update the track info display */
export function updateVideoPreview(
  state: ModalState,
  currentItem: PlaylistItem | null,
  currentDj: Record<string, unknown> | null,
  _trackStartedAt: string | null | undefined,
  stopDurationTimerFn: () => void,
): void {
  const previewTrackInfo = document.getElementById('previewTrackInfo');
  const previewTitle = document.getElementById('previewTrackTitle');
  const previewDjName = document.getElementById('previewTrackDj');

  if (!currentItem) {
    if (previewTrackInfo) previewTrackInfo.classList.add('hidden');
    if (previewTitle) previewTitle.textContent = '--';
    if (previewDjName) previewDjName.textContent = 'Selector: --';
    stopDurationTimerFn();
    return;
  }

  if (previewTrackInfo) previewTrackInfo.classList.remove('hidden');

  const title = currentItem.title || 'Unknown Track';
  const needsFetch = isPlaceholderTitle(title) && currentItem.url;

  if (needsFetch && (currentItem.url.includes('youtube.com') || currentItem.url.includes('youtu.be'))) {
    if (previewTitle) previewTitle.textContent = 'Loading...';

    const videoId = getYouTubeId(currentItem.url);
    if (videoId) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);
      fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          if (data?.title && previewTitle) {
            previewTitle.textContent = data.title;
            currentItem.title = data.title;
          }
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') {
            state.log.warn('YouTube oEmbed timed out for preview');
          }
          if (previewTitle) previewTitle.textContent = title;
        })
        .finally(() => {
          clearTimeout(timeoutId);
        });
    }
  } else {
    if (previewTitle) previewTitle.textContent = title;
  }

  if (previewDjName) previewDjName.textContent = `Selector: ${currentDj?.userName || currentItem.addedByName || 'Unknown'}`;
}

/** Refresh all recently played time displays */
export function refreshRecentlyPlayedTimes(): void {
  const timeElements = document.querySelectorAll('.recently-played-time[data-played-at]');
  timeElements.forEach(el => {
    const playedAt = el.getAttribute('data-played-at');
    if (playedAt) {
      el.textContent = formatTimeAgo(playedAt);
    }
  });
}

/** Start recently played time updates interval */
export function startRecentlyPlayedTimeUpdates(state: ModalState): void {
  if (state.recentlyPlayedTimeInterval) return;
  state.recentlyPlayedTimeInterval = window.setInterval(refreshRecentlyPlayedTimes, TIMEOUTS.RECENTLY_PLAYED_REFRESH);
}

/** Stop recently played time updates interval */
export function stopRecentlyPlayedTimeUpdates(state: ModalState): void {
  if (state.recentlyPlayedTimeInterval) {
    window.clearInterval(state.recentlyPlayedTimeInterval);
    state.recentlyPlayedTimeInterval = null;
  }
}

/** Copy to clipboard function */
export async function copyToClipboard(state: ModalState, url: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    const originalText = btn.innerHTML;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
    setTimeout(() => {
      btn.innerHTML = originalText;
    }, 2000);
  } catch (err: unknown) {
    state.log.error('Failed to copy:', err);
  }
}
