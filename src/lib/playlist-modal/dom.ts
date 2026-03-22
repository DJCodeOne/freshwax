// src/lib/playlist-modal/dom.ts
// DOM manipulation and rendering functions for the playlist modal.

import { escapeHtml } from '../escape-html';
import { createClientLogger } from '../client-logger';
import type { PlaylistItem, PlaylistModalState } from './types';
import { ITEMS_PER_PAGE, MAX_ITEMS } from './types';

const log = createClientLogger('PlaylistModal');

// ─── Small helpers ──────────────────────────────────────────────────────────

/** Inline platform name helper (avoids importing url-parser.ts in synchronous render paths) */
export function platformName(platform: string): string {
  switch (platform) {
    case 'youtube': return 'YouTube';
    case 'vimeo': return 'Vimeo';
    case 'soundcloud': return 'SoundCloud';
    case 'direct': return 'Direct';
    default: return 'Unknown';
  }
}

/** Format duration as mm:ss or h:mm:ss */
export function formatDuration(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Format date for display */
export function formatAddedDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_e: unknown) { /* non-critical: invalid date string -- return empty for graceful display */
    return '';
  }
}

/** Format relative time from ISO timestamp */
export function formatTimeAgo(playedAt: string): string {
  if (!playedAt) return '';
  const playedTime = new Date(playedAt).getTime();
  const now = Date.now();
  const diffMs = now - playedTime;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${diffWeeks}w ago`;
}

/** Sort personal playlist items */
export function sortPersonalItems(items: PlaylistItem[], sortOrder: string): PlaylistItem[] {
  const sorted = [...items];
  switch (sortOrder) {
    case 'recent':
      return sorted.reverse();
    case 'oldest':
      return sorted;
    case 'alpha-az':
      return sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    case 'alpha-za':
      return sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    default:
      return sorted.reverse();
  }
}

/** Check if title is a placeholder */
export function isPlaceholderTitle(title?: string): boolean {
  if (!title) return true;
  return /^Track\s*\d+$/i.test(title) ||
         /^YouTube Video$/i.test(title) ||
         /^SoundCloud Track$/i.test(title) ||
         /^Media Track$/i.test(title) ||
         /^Unknown Track$/i.test(title);
}

/** Extract YouTube video ID from URL */
export function getYouTubeId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// Map to store focus trap handlers per element (avoids `as any` casts)
const focusTrapHandlers = new WeakMap<HTMLElement, (e: KeyboardEvent) => void>();

/** Focus trap helper for modal dialogs */
export function trapFocus(modalEl: HTMLElement) {
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusableElements = modalEl.querySelectorAll<HTMLElement>(focusableSelector);
  if (focusableElements.length === 0) return;
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  };
  focusTrapHandlers.set(modalEl, handler);
  modalEl.addEventListener('keydown', handler);
  firstFocusable.focus();
}

export function removeFocusTrap(modalEl: HTMLElement) {
  const handler = focusTrapHandlers.get(modalEl);
  if (handler) {
    modalEl.removeEventListener('keydown', handler);
    focusTrapHandlers.delete(modalEl);
  }
}

// ─── Inject modal HTML ──────────────────────────────────────────────────────

/** Inject the full modal HTML into the #playlistModal container. */
export function injectModalHTML() {
  const container = document.getElementById('playlistModal');
  if (!container) return;

  // Detect mobile for inline style overrides (CSS can be cached/overridden)
  const isMobile = window.innerWidth <= 768;
  const mobileWrap = isMobile ? 'style="width:100%;max-width:100vw;overflow-x:hidden;box-sizing:border-box;"' : '';
  const mobileBody = isMobile ? 'style="width:100%;max-width:100vw;overflow-x:hidden;overflow-y:auto;box-sizing:border-box;padding:0.75rem;"' : '';
  const mobileCols = isMobile ? 'style="display:flex;flex-direction:column;gap:1rem;width:100%;max-width:100%;overflow:visible;"' : '';
  const mobileCol = isMobile ? 'style="width:100%;max-width:100%;overflow:visible;padding:0;border:none;"' : '';

  // Replace the loading spinner with the full modal content
  container.innerHTML = `
  <div class="playlist-modal-backdrop"></div>
  <div class="playlist-modal-content playlist-modal-large" ${mobileWrap}>
    <div class="playlist-modal-header">
      <button id="backFromPlaylist" class="back-btn" aria-label="Back to stream">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        <span>Back</span>
      </button>
      <h2>Playlist</h2>
      <button id="closePlaylistModal" class="close-btn" aria-label="Close playlist">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="playlist-modal-body" ${mobileBody}>
      <div id="nowPlayingStrip" class="now-playing-strip hidden">
        <div class="now-playing-label">
          <span class="now-playing-pulse"></span>
          NOW PLAYING
        </div>
        <div class="now-playing-info">
          <span id="nowPlayingTitle" class="now-playing-title">--</span>
        </div>
      </div>

      <div class="playlist-columns" ${mobileCols}>
        <div class="playlist-column queue-column" ${mobileCol}>
          <div class="playlist-add-section">
            <div id="playlistAuthNotice" class="playlist-auth-notice hidden">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>Sign in to add videos to the playlist</span>
            </div>
            <div id="playlistInputGroup" class="playlist-input-group">
              <label for="playlistUrlInput" class="sr-only">Playlist URL</label>
              <input
                type="url"
                id="playlistUrlInput"
                class="playlist-url-input"
                placeholder="Paste a YouTube Link..."
                autocomplete="off"
                aria-label="Paste a YouTube link to add to the playlist"
              />
              <button id="clearPlaylistInput" class="clear-input-btn hidden" title="Clear input" aria-label="Clear input">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
              <div class="input-button-group">
                <button id="addToPlaylistBtn" class="add-to-playlist-btn" title="Add to Playlist Queue">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  Queue
                </button>
                <button id="saveForLaterBtn" class="save-for-later-btn" title="Save to My Playlist for later">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                  </svg>
                  Save
                </button>
              </div>
            </div>
            <div id="playlistError" class="playlist-error hidden"></div>
            <div id="playlistSuccess" class="playlist-success hidden"></div>
          </div>

          <div class="queue-split-container">
            <div class="queue-list-side">
              <div class="playlist-queue-header">
                <h3>Playlist Queue <span id="queueCount" class="queue-count">0/10</span></h3>
              </div>
              <div id="positionIndicator" class="position-indicator hidden">
                <span id="positionText"></span>
              </div>
              <div id="playlistQueue" class="playlist-queue-grid">
                <div class="playlist-empty">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  <p>Playlist is empty</p>
                  <p class="playlist-empty-hint">Add a track to join</p>
                </div>
              </div>
            </div>

            <div class="queue-preview-side">
              <div id="yourTrackIndicator" class="your-track-indicator hidden">
                <span id="yourTrackText">\uD83C\uDFA7 YOUR TRACK IS PLAYING</span>
              </div>
              <div class="preview-header">
                <h3>Now Playing</h3>
              </div>
              <div id="previewTrackInfo" class="preview-track-info">
                <div class="preview-track-title" id="previewTrackTitle">--</div>
                <div class="preview-track-bottom">
                  <div class="preview-track-dj" id="previewTrackDj">Selector: --</div>
                  <div class="preview-duration-box" id="previewDurationBox">
                    <span class="preview-duration-value" id="previewDuration">--:--</span>
                    <span class="preview-duration-label">LEFT</span>
                  </div>
                </div>
              </div>

              <div class="recently-played-section">
                <div class="recently-played-header">
                  <h4>Recently Played</h4>
                </div>
                <div id="recentlyPlayedList" class="recently-played-list">
                  <div class="recently-played-empty">No tracks played yet</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="playlist-column my-playlist-column" ${mobileCol}>
          <div id="myPlaylistSection" class="my-playlist-section" style="display:flex;${isMobile ? 'width:100%;max-width:100%;height:auto;' : ''}">
            <div class="my-playlist-header">
              <div class="my-playlist-title-group">
                <h3>My Playlist</h3>
                <span id="myPlaylistCount" class="my-playlist-count-box">0</span>
              </div>
              <div class="my-playlist-actions">
                <select id="playlistSortSelect" class="playlist-sort-select">
                  <option value="recent">Recently Added</option>
                  <option value="oldest">Oldest First</option>
                  <option value="alpha-az">A-Z</option>
                  <option value="alpha-za">Z-A</option>
                </select>
                <div class="playlist-layout-toggle">
                  <button id="layoutSingleBtn" class="layout-btn active" title="Single column">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="18" height="4" rx="1"></rect>
                      <rect x="3" y="10" width="18" height="4" rx="1"></rect>
                      <rect x="3" y="17" width="18" height="4" rx="1"></rect>
                    </svg>
                  </button>
                  <button id="layoutGridBtn" class="layout-btn" title="Two columns">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                      <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                      <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                      <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                    </svg>
                  </button>
                </div>
                <button id="exportPlaylistBtn" class="export-playlist-btn" title="Export playlist">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  Export
                </button>
                <button id="backToStreamBtn" class="back-to-stream-btn" title="Back to stream">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"></polyline>
                  </svg>
                  Back
                </button>
              </div>
            </div>

            <div id="exportModal" class="export-modal hidden">
              <div class="export-modal-backdrop"></div>
              <div class="export-modal-content">
                <div class="export-modal-header">
                  <h3>Export Playlist</h3>
                  <button id="closeExportModal" class="export-modal-close">&times;</button>
                </div>

                <div class="export-modal-body">
                  <div class="export-field">
                    <label for="exportTitle">Playlist Title</label>
                    <input type="text" id="exportTitle" placeholder="My Fresh Wax Playlist" />
                  </div>

                  <fieldset class="export-field" style="border:0;padding:0;margin:0;">
                    <legend>Export Format</legend>
                    <div class="export-formats">
                      <label class="format-option">
                        <input type="radio" name="exportFormat" value="txt" checked />
                        <span class="format-label">
                          <span class="format-name">TXT</span>
                          <span class="format-desc">Plain text file</span>
                        </span>
                      </label>
                      <label class="format-option">
                        <input type="radio" name="exportFormat" value="csv" />
                        <span class="format-label">
                          <span class="format-name">CSV</span>
                          <span class="format-desc">Spreadsheet</span>
                        </span>
                      </label>
                      <label class="format-option">
                        <input type="radio" name="exportFormat" value="pdf" />
                        <span class="format-label">
                          <span class="format-name">PDF</span>
                          <span class="format-desc">Printable</span>
                        </span>
                      </label>
                    </div>
                  </fieldset>

                  <div class="export-info">
                    <span id="exportTrackCount">0</span> tracks will be exported
                  </div>

                  <button id="confirmExportBtn" class="confirm-export-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Download Playlist
                  </button>
                </div>

                <div class="export-modal-divider"></div>

                <div class="export-modal-danger">
                  <h4>Danger Zone</h4>
                  <p>Clear all tracks from your playlist. This cannot be undone.</p>
                  <button id="clearPlaylistBtn" class="clear-playlist-danger-btn">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18"></path>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    Clear Playlist
                  </button>
                </div>

                <div id="clearConfirmation" class="clear-confirmation hidden">
                  <p>Are you sure? This will remove all <span id="clearItemCount">0</span> tracks.</p>
                  <div class="clear-confirm-actions">
                    <button id="cancelClearBtn" class="cancel-clear-btn">Cancel</button>
                    <button id="confirmClearBtn" class="confirm-clear-btn">Yes, Clear All</button>
                  </div>
                </div>
              </div>
            </div>
            <div id="myPlaylistPagination" class="my-playlist-pagination hidden"></div>
            <div id="myPlaylistGrid" class="my-playlist-grid">
              <div class="playlist-empty">
                <p>Your playlist is empty</p>
                <p class="playlist-empty-hint">Save tracks for later</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="playlist-modal-footer">
      <span class="footer-logo"><span class="footer-fresh">Fresh</span><span class="footer-wax">Wax</span></span>
      <span class="footer-tagline">community playlist</span>
    </div>

  </div>`;
}

// ─── Duration timer ─────────────────────────────────────────────────────────

/** Update the duration display (countdown) */
export function updateDurationDisplay(state: PlaylistModalState) {
  const durationEl = document.getElementById('previewDuration');
  if (!durationEl || !state.currentTrackStartTime) return;

  const elapsed = Math.floor((Date.now() - state.currentTrackStartTime) / 1000);

  if (state.currentTrackDuration) {
    const remaining = state.currentTrackDuration - elapsed;
    durationEl.textContent = formatDuration(remaining);
  } else {
    durationEl.textContent = formatDuration(elapsed);
  }
}

/** Stop the duration timer */
export function stopDurationTimer(state: PlaylistModalState) {
  if (state.durationInterval) {
    clearInterval(state.durationInterval);
    state.durationInterval = null;
  }
  state.currentTrackStartTime = null;
  state.currentTrackDuration = null;
  const durationEl = document.getElementById('previewDuration');
  if (durationEl) durationEl.textContent = '--:--';
}

// ─── Auth UI ────────────────────────────────────────────────────────────────

/** Update UI based on authentication state */
export function updateAuthUI(state: PlaylistModalState) {
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

// ─── Position indicator ─────────────────────────────────────────────────────

/** Update position indicator based on user's queue position */
export function updatePositionIndicator(state: PlaylistModalState, position: number | null, isUsersTurn: boolean, _queueSize: number) {
  const indicator = document.getElementById('positionIndicator');
  const positionText = document.getElementById('positionText');
  const yourTrackIndicator = document.getElementById('yourTrackIndicator');

  if (!indicator || !positionText) return;

  indicator.classList.add('hidden');
  indicator.classList.remove('your-turn');
  yourTrackIndicator?.classList.add('hidden');

  if (!state.isAuthenticated || position === null) return;

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

// ─── Now playing strip ──────────────────────────────────────────────────────

/** Update Now Playing Strip */
export function updateNowPlayingStrip(
  state: PlaylistModalState,
  queue: PlaylistItem[],
  currentIndex: number,
  currentDj: Record<string, unknown> | null,
  trackStartedAt?: string | null
) {
  const strip = document.getElementById('nowPlayingStrip');
  const title = document.getElementById('nowPlayingTitle');

  if (!strip || !title) return;

  if (queue.length === 0 || currentIndex >= queue.length) {
    strip.classList.add('hidden');
    updateVideoPreview(state, null, null, null);
    return;
  }

  const currentItem = queue[currentIndex];
  strip.classList.remove('hidden');
  title.textContent = currentItem?.title || 'Unknown Track';
  updateVideoPreview(state, currentItem, currentDj, trackStartedAt);
}

// ─── Video preview ──────────────────────────────────────────────────────────

/** Update the track info display */
export function updateVideoPreview(
  state: PlaylistModalState,
  currentItem: PlaylistItem | null,
  currentDj: Record<string, unknown> | null,
  _trackStartedAt?: string | null
) {
  const previewTrackInfo = document.getElementById('previewTrackInfo');
  const previewTitle = document.getElementById('previewTrackTitle');
  const previewDjName = document.getElementById('previewTrackDj');

  if (!currentItem) {
    if (previewTrackInfo) previewTrackInfo.classList.add('hidden');
    if (previewTitle) previewTitle.textContent = '--';
    if (previewDjName) previewDjName.textContent = 'Selector: --';
    stopDurationTimer(state);
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
      const timeoutId = setTimeout(() => controller.abort(), 10000);
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
            log.warn('YouTube oEmbed timed out for preview');
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

// ─── Recently played ────────────────────────────────────────────────────────

/** Render the recently played list */
export function renderRecentlyPlayed(container: HTMLElement, tracks: PlaylistItem[]) {
  if (!tracks || tracks.length === 0) {
    container.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
    return;
  }

  container.innerHTML = tracks.slice(0, 10).map((track, index) => {
    let title = track.title || track.name || '';

    if (isPlaceholderTitle(title)) {
      if (track.addedByName && track.addedByName !== 'Auto-Play' && track.addedByName !== 'Playlist Import') {
        title = `Track by ${track.addedByName}`;
      } else if (track.embedId) {
        title = `Video: ${track.embedId}`;
      } else {
        title = 'Unknown Track';
      }
    }

    const truncatedTitle = title.length > 40 ? title.slice(0, 40) + '...' : title;

    let timeAgo = '';
    if (track.playedAt) {
      timeAgo = formatTimeAgo(track.playedAt);
    }

    return `
      <div class="recently-played-item">
        <span class="recently-played-number">${index + 1}</span>
        <div class="recently-played-info">
          <span class="recently-played-title" data-track-index="${index}" title="${escapeHtml(title)}">${escapeHtml(truncatedTitle)}</span>
          <span class="recently-played-time" data-played-at="${track.playedAt || ''}">${timeAgo}</span>
        </div>
      </div>
    `;
  }).join('');

  // Asynchronously fetch real titles for YouTube tracks with placeholder titles
  tracks.slice(0, 10).forEach(async (track, index) => {
    const title = track.title || track.name || '';
    const needsFetch = isPlaceholderTitle(title) && track.url;

    if (needsFetch && (track.url.includes('youtube.com') || track.url.includes('youtu.be'))) {
      const videoId = getYouTubeId(track.url) || track.embedId;
      if (videoId) {
        try {
          const response = await fetch(`/api/youtube/title/?videoId=${videoId}`);
          if (response.ok) {
            const data = await response.json();
            if (data?.success && data.title) {
              const titleEl = container?.querySelector(`.recently-played-title[data-track-index="${index}"]`) as HTMLElement;
              if (titleEl) {
                const truncatedTitle = data.title.length > 40 ? data.title.slice(0, 40) + '...' : data.title;
                titleEl.textContent = truncatedTitle;
                titleEl.setAttribute('title', data.title);
              }
              track.title = data.title;
            }
          }
        } catch (e: unknown) {
          log.warn('Could not fetch YouTube title for', videoId, e);
        }
      }
    }
  });
}

/** Refresh all recently played time displays */
export function refreshRecentlyPlayedTimes() {
  const timeElements = document.querySelectorAll('.recently-played-time[data-played-at]');
  timeElements.forEach(el => {
    const playedAt = el.getAttribute('data-played-at');
    if (playedAt) {
      el.textContent = formatTimeAgo(playedAt);
    }
  });
}

/** Start updating recently played times every minute */
export function startRecentlyPlayedTimeUpdates(state: PlaylistModalState) {
  if (state.recentlyPlayedTimeInterval) return;
  state.recentlyPlayedTimeInterval = window.setInterval(refreshRecentlyPlayedTimes, 60000);
}

/** Stop updating recently played times */
export function stopRecentlyPlayedTimeUpdates(state: PlaylistModalState) {
  if (state.recentlyPlayedTimeInterval) {
    window.clearInterval(state.recentlyPlayedTimeInterval);
    state.recentlyPlayedTimeInterval = null;
  }
}

// ─── Queue rendering ────────────────────────────────────────────────────────

/** Copy to clipboard function */
async function copyToClipboard(url: string, btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(url);
    const originalText = btn.innerHTML;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
    setTimeout(() => {
      btn.innerHTML = originalText;
    }, 2000);
  } catch (err: unknown) {
    log.error('Failed to copy:', err);
  }
}

/** Render queue items in compact DJ waitlist format */
export function renderQueue(state: PlaylistModalState, queue: PlaylistItem[], currentIndex: number) {
  const queueDiv = document.getElementById('playlistQueue');
  if (!queueDiv) return;

  if (queue.length === 0) {
    queueDiv.innerHTML = `
      <div class="playlist-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <p>Playlist is empty</p>
        <p class="playlist-empty-hint">${state.isAuthenticated ? 'Add a track to join' : 'Sign in to join'}</p>
      </div>
    `;
    return;
  }

  queueDiv.innerHTML = queue.map((item, index) => {
    const canRemove = state.isAuthenticated && state.currentUserId && item.addedBy === state.currentUserId;
    const djName = item.addedByName || 'Anonymous';
    const isCurrentTrack = index === 0;
    const isUsersTrack = state.currentUserId && item.addedBy === state.currentUserId;
    const position = index + 1;
    const positionLabel = isCurrentTrack ? '\u25B6' : `#${position}`;

    return `
      <div class="playlist-grid-item ${isCurrentTrack ? 'active' : ''} ${isUsersTrack ? 'your-track' : ''}" data-id="${item.id}">
        <div class="dj-position-badge">${positionLabel}</div>
        <div class="playlist-grid-thumb">
          ${item.thumbnail
            ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title || 'Video')}" loading="lazy" />`
            : `<div class="playlist-grid-thumb-placeholder">
                <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              </div>`
          }
        </div>
        <div class="playlist-grid-info">
          <div class="playlist-grid-title">${escapeHtml(item.title || 'Untitled')}</div>
          <div class="dj-name-display">Selector: ${escapeHtml(djName)}${isUsersTrack ? ' (You)' : ''}</div>
        </div>
        <div class="playlist-grid-actions">
          ${state.isAuthenticated ? `
            <button class="playlist-action-btn playlist-save-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || '')}" data-thumbnail="${escapeHtml(item.thumbnail || '')}" title="Save to My Playlist" aria-label="Save to My Playlist">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
              </svg>
            </button>
          ` : ''}
          ${canRemove ? `
            <button class="playlist-action-btn playlist-remove-btn" data-id="${item.id}" title="Leave Queue" aria-label="Remove from queue">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Add copy button listeners
  queueDiv.querySelectorAll('.playlist-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url;
      if (url) {
        await copyToClipboard(url, e.currentTarget as HTMLElement);
      }
    });
  });

  // Add remove button listeners
  queueDiv.querySelectorAll('.playlist-remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = (e.currentTarget as HTMLElement).dataset.id;
      if (itemId && state.playlistManager) {
        await state.playlistManager.removeItem(itemId);
      }
    });
  });

  // Add save to personal playlist button listeners
  queueDiv.querySelectorAll('.playlist-save-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const el = e.currentTarget as HTMLElement;
      const url = el.dataset.url;
      const title = el.dataset.title;
      const thumbnail = el.dataset.thumbnail;
      if (url && state.playlistManager) {
        const button = e.currentTarget as HTMLButtonElement;
        const originalHTML = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning"><circle cx="12" cy="12" r="10"></circle></svg>';

        const result = await state.playlistManager.addToPersonalPlaylist(url, title, thumbnail);

        if (result.success) {
          button.innerHTML = '<svg viewBox="0 0 24 24" fill="#22c55e" stroke="#22c55e" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
          button.title = 'Saved!';
          const successDiv = document.getElementById('playlistSuccess');
          if (successDiv) {
            successDiv.textContent = result.message || 'Saved to your playlist!';
            successDiv.classList.remove('hidden');
            setTimeout(() => successDiv.classList.add('hidden'), 3000);
          }
        } else {
          button.innerHTML = originalHTML;
          button.disabled = false;
          const errorDiv = document.getElementById('playlistError');
          if (errorDiv) {
            errorDiv.textContent = result.error || 'Failed to save';
            errorDiv.classList.remove('hidden');
            setTimeout(() => errorDiv.classList.add('hidden'), 4000);
          }
        }
      }
    });
  });
}

// ─── Personal playlist ──────────────────────────────────────────────────────

/** Render personal playlist items with pagination */
export function renderPersonalPlaylist(state: PlaylistModalState, personalItems: PlaylistItem[], userTracksInQueue: number) {
  const section = document.getElementById('myPlaylistSection');
  const grid = document.getElementById('myPlaylistGrid');
  const countEl = document.getElementById('myPlaylistCount');
  const paginationEl = document.getElementById('myPlaylistPagination');

  if (!section || !grid) return;

  state.cachedPersonalItems = personalItems;
  state.cachedUserTracksInQueue = userTracksInQueue;

  section.classList.remove('hidden');

  if (countEl) {
    countEl.textContent = state.isAuthenticated ? personalItems.length.toString() : '0';
  }

  if (!state.isAuthenticated) {
    if (paginationEl) paginationEl.classList.add('hidden');
    grid.innerHTML = `
      <div class="playlist-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.4; margin-bottom: 0.5rem;">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
        </svg>
        <p>Sign in to save tracks</p>
        <p class="playlist-empty-hint">Build your playlist for later</p>
      </div>
    `;
    return;
  }

  if (personalItems.length === 0) {
    if (paginationEl) paginationEl.classList.add('hidden');
    grid.innerHTML = `
      <div class="playlist-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.4; margin-bottom: 0.5rem;">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
        </svg>
        <p>Your playlist is empty</p>
        <p class="playlist-empty-hint">Click "Save" to add tracks for later</p>
      </div>
    `;
    return;
  }

  const totalItems = Math.min(personalItems.length, MAX_ITEMS);
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

  if (state.currentPlaylistPage > totalPages) {
    state.currentPlaylistPage = totalPages;
  }
  if (state.currentPlaylistPage < 1) {
    state.currentPlaylistPage = 1;
  }

  if (paginationEl) {
    if (totalItems > ITEMS_PER_PAGE) {
      paginationEl.classList.remove('hidden');
      let paginationHTML = '';
      for (let i = 1; i <= totalPages; i++) {
        const startItem = (i - 1) * ITEMS_PER_PAGE + 1;
        const endItem = Math.min(i * ITEMS_PER_PAGE, totalItems);
        paginationHTML += `
          <button class="playlist-page-btn ${i === state.currentPlaylistPage ? 'active' : ''}" data-page="${i}">
            ${startItem}-${endItem}
          </button>
        `;
      }
      paginationEl.innerHTML = paginationHTML;

      paginationEl.querySelectorAll('.playlist-page-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const page = parseInt((e.currentTarget as HTMLElement).dataset.page || '1', 10);
          if (page !== state.currentPlaylistPage) {
            state.currentPlaylistPage = page;
            const freshSortedItems = sortPersonalItems(state.cachedPersonalItems, state.currentSortOrder);
            renderPersonalPlaylistPage(state, freshSortedItems, state.cachedUserTracksInQueue);
            paginationEl.querySelectorAll('.playlist-page-btn').forEach(b => b.classList.remove('active'));
            (e.currentTarget as HTMLElement).classList.add('active');
          }
        });
      });
    } else {
      paginationEl.classList.add('hidden');
    }
  }

  const sortedItems = sortPersonalItems(personalItems, state.currentSortOrder);
  renderPersonalPlaylistPage(state, sortedItems, userTracksInQueue);
}

/** Render a specific page of the personal playlist */
export function renderPersonalPlaylistPage(state: PlaylistModalState, sortedItems: PlaylistItem[], userTracksInQueue: number) {
  const grid = document.getElementById('myPlaylistGrid');
  if (!grid) return;

  const startIndex = (state.currentPlaylistPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, sortedItems.length, MAX_ITEMS);
  const pageItems = sortedItems.slice(startIndex, endIndex);

  grid.innerHTML = pageItems.map((item) => `
    <div class="personal-playlist-item" data-id="${item.id}">
      <div class="personal-item-thumb">
        ${item.thumbnail
          ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title || 'Track')}" loading="lazy" />`
          : `<svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(139,92,246,0.5)"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
        }
      </div>
      <div class="personal-item-info">
        <div class="personal-item-title">${escapeHtml(item.title || 'Untitled')}</div>
        <div class="personal-item-meta">
          <span class="personal-item-platform">${platformName(item.platform)}</span>
          ${item.addedAt ? `<span class="personal-item-date">${formatAddedDate(item.addedAt)}</span>` : ''}
        </div>
      </div>
      <div class="personal-item-actions">
        <button class="personal-add-btn" data-id="${item.id}" ${userTracksInQueue >= 2 ? 'disabled title="You already have 2 tracks in the queue"' : 'title="Add to Playlist Queue"'}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          Queue
        </button>
        <button class="personal-delete-btn" data-id="${item.id}" title="Remove from playlist" aria-label="Remove from playlist">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
  `).join('');

  // Add event listeners for personal playlist buttons
  grid.querySelectorAll('.personal-add-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = (e.currentTarget as HTMLElement).dataset.id;
      if (itemId && state.playlistManager) {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = '...';

        const result = await state.playlistManager.addPersonalItemToQueue(itemId);

        if (result.success) {
          const successDiv = document.getElementById('playlistSuccess');
          if (successDiv) {
            successDiv.textContent = result.message || 'Added to queue!';
            successDiv.classList.remove('hidden');
            setTimeout(() => successDiv.classList.add('hidden'), 3000);
          }
        } else {
          const errorDiv = document.getElementById('playlistError');
          if (errorDiv) {
            errorDiv.textContent = result.error || 'Failed to add';
            errorDiv.classList.remove('hidden');
            setTimeout(() => errorDiv.classList.add('hidden'), 4000);
          }
          btn.disabled = false;
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Queue';
        }
      }
    });
  });

  grid.querySelectorAll('.personal-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const button = e.currentTarget as HTMLElement;
      const itemId = button.dataset.id;
      if (!itemId || !state.playlistManager) return;

      if (button.classList.contains('confirming')) {
        state.playlistManager.removeFromPersonalPlaylist(itemId);
        return;
      }

      button.classList.add('confirming');
      const originalHTML = button.innerHTML;
      button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      button.title = 'Click again to confirm';

      setTimeout(() => {
        if (button.classList.contains('confirming')) {
          button.classList.remove('confirming');
          button.innerHTML = originalHTML;
          button.title = 'Remove from playlist';
        }
      }, 3000);
    });
  });
}
