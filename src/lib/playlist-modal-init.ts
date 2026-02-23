// src/lib/playlist-modal-init.ts
// Lazy-loaded playlist modal initialization module.
// Extracted from PlaylistModal.astro <script> to enable dynamic import
// and reduce initial JS payload on the live page (~78KB+ savings).
// The modal HTML is injected on demand — only when the user opens the modal.

// PlaylistManager, url-parser, and constants are dynamically imported to enable
// Vite code splitting. The modal HTML and event listeners load immediately (~15KB),
// while the heavy playlist manager (~60KB) loads in the background during init.
import type { PlaylistManager } from './playlist-manager';

// Lightweight interface for playlist items used in the modal UI
interface PlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedAt?: string;
  addedBy?: string;
  addedByName?: string;
  playedAt?: string;
  name?: string;
}

// Guard against multiple initializations
let _initialized = false;

/** Inject the full modal HTML into the #playlistModal container. */
function injectModalHTML() {
  const container = document.getElementById('playlistModal');
  if (!container) return;

  // Replace the loading spinner with the full modal content
  container.innerHTML = `
  <div class="playlist-modal-backdrop"></div>
  <div class="playlist-modal-content playlist-modal-large">
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

    <div class="playlist-modal-body">
      <div id="nowPlayingStrip" class="now-playing-strip hidden">
        <div class="now-playing-label">
          <span class="now-playing-pulse"></span>
          NOW PLAYING
        </div>
        <div class="now-playing-info">
          <span id="nowPlayingTitle" class="now-playing-title">--</span>
        </div>
      </div>

      <div class="playlist-columns">
        <div class="playlist-column queue-column">
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
              <input
                type="url"
                id="playlistUrlInput"
                class="playlist-url-input"
                placeholder="Paste a YouTube Or SoundCloud Link Here..."
                autocomplete="off"
              />
              <button id="clearPlaylistInput" class="clear-input-btn hidden" title="Clear input">
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

        <div class="playlist-column my-playlist-column">
          <div id="myPlaylistSection" class="my-playlist-section" style="display: flex;">
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

export function initPlaylistModal() {
  if (_initialized) return;
  _initialized = true;

  // Inject the full modal HTML into the placeholder container
  injectModalHTML();

  // Inline platform name helper (avoids importing url-parser.ts in synchronous render paths)
  function platformName(platform: string): string {
    switch (platform) {
      case 'youtube': return 'YouTube';
      case 'vimeo': return 'Vimeo';
      case 'soundcloud': return 'SoundCloud';
      case 'direct': return 'Direct';
      default: return 'Unknown';
    }
  }

  // Global playlist manager instance
  let playlistManager: PlaylistManager | null = null;
  let isStopped = false;
  let currentUserId: string | null = null;
  let isAuthenticated = false;
  let hasInitializedThisPage = false; // Prevent duplicate initialization
  let listenersAttached = false; // Prevent duplicate event listeners
  let isAddingToPlaylist = false; // Prevent duplicate add submissions

  // Duration timer state
  let durationInterval: ReturnType<typeof setInterval> | null = null;
  let currentTrackStartTime: number | null = null;
  let currentTrackDuration: number | null = null;
  let lastTrackId: string | null = null;

  // Format duration as mm:ss or h:mm:ss
  function formatDuration(seconds: number): string {
    if (seconds < 0) seconds = 0;
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Fetch video duration from YouTube API
  async function fetchVideoDuration(platform: string, embedId: string): Promise<number | null> {
    if (platform === 'youtube' && embedId) {
      try {
        const response = await fetch(`/api/youtube/duration/?videoId=${embedId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.duration) {
            return data.duration;
          }
        }
      } catch (error: unknown) {
        console.warn('[PlaylistModal] Could not fetch duration:', error);
      }
    }
    return null;
  }

  // Update the duration display (countdown)
  function updateDurationDisplay() {
    const durationEl = document.getElementById('previewDuration');
    if (!durationEl || !currentTrackStartTime) return;

    const elapsed = Math.floor((Date.now() - currentTrackStartTime) / 1000);

    if (currentTrackDuration) {
      // Countdown mode
      const remaining = currentTrackDuration - elapsed;
      durationEl.textContent = formatDuration(remaining);
    } else {
      // Fallback: show elapsed if no duration available
      durationEl.textContent = formatDuration(elapsed);
    }
  }

  // Start the duration timer for a new track
  async function startDurationTimer(trackId: string, platform?: string, embedId?: string, trackStartedAt?: string | null) {
    // If same track, don't restart
    if (trackId === lastTrackId && durationInterval) return;

    // Stop existing timer
    stopDurationTimer();

    lastTrackId = trackId;
    // Use trackStartedAt from server if available, otherwise fallback to current time
    currentTrackStartTime = trackStartedAt ? new Date(trackStartedAt).getTime() : Date.now();
    currentTrackDuration = null;

    // Show initial state
    const durationEl = document.getElementById('previewDuration');
    if (durationEl) durationEl.textContent = '--:--';

    // Try to fetch duration
    if (platform && embedId) {
      const duration = await fetchVideoDuration(platform, embedId);
      if (duration) {
        currentTrackDuration = duration;
      }
    }

    updateDurationDisplay();
    durationInterval = setInterval(updateDurationDisplay, 1000);
  }

  // Stop the duration timer
  function stopDurationTimer() {
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }
    currentTrackStartTime = null;
    currentTrackDuration = null;
    const durationEl = document.getElementById('previewDuration');
    if (durationEl) durationEl.textContent = '--:--';
  }

  // Personal playlist pagination state
  const ITEMS_PER_PAGE = 20;
  const MAX_ITEMS = 500;
  let currentPlaylistPage = 1;
  let cachedPersonalItems: PlaylistItem[] = [];
  let cachedUserTracksInQueue = 0;
  let currentSortOrder: 'recent' | 'oldest' | 'alpha-az' | 'alpha-za' = 'recent';

  // Sort personal playlist items
  function sortPersonalItems(items: PlaylistItem[], sortOrder: string): PlaylistItem[] {
    const sorted = [...items];
    switch (sortOrder) {
      case 'recent':
        // Most recent first (reverse of original order which is oldest first)
        return sorted.reverse();
      case 'oldest':
        // Oldest first (original order)
        return sorted;
      case 'alpha-az':
        return sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      case 'alpha-za':
        return sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
      default:
        return sorted.reverse();
    }
  }

  // Format date for display
  function formatAddedDate(dateStr: string): string {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return '';
    }
  }

  // Initialize playlist on page load
  async function initPlaylist() {
    if (playlistManager) return;

    // Get user from window.currentUserInfo (set by live.astro auth)
    const userInfo = window.currentUserInfo;
    currentUserId = userInfo?.id || null;
    isAuthenticated = userInfo?.loggedIn || false;

    // Dynamic import: PlaylistManager (~60KB) loads as a separate chunk
    const { PlaylistManager: PM } = await import('./playlist-manager');
    playlistManager = new PM('playlistPlayer');
    await playlistManager.initialize(currentUserId || undefined, userInfo?.displayName || userInfo?.name);

    // Update UI based on auth state
    updateAuthUI();

    // Expose globally for live-stream.js
    window.playlistManager = playlistManager;
  }

  // Update UI based on authentication state
  function updateAuthUI() {
    const authNotice = document.getElementById('playlistAuthNotice');
    const inputGroup = document.getElementById('playlistInputGroup');

    if (isAuthenticated) {
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

  // Session storage key for persisting auth state
  const AUTH_STORAGE_KEY = 'freshwax_playlist_auth';

  // Save auth state to sessionStorage
  function saveAuthState() {
    if (isAuthenticated && currentUserId) {
      const userInfo = window.currentUserInfo;
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
        id: currentUserId,
        name: userInfo?.displayName || userInfo?.name || 'User',
        loggedIn: true
      }));
    }
  }

  // Check if auth is already ready (from window or sessionStorage)
  function checkExistingAuth() {
    // First check window.currentUserInfo
    const userInfo = window.currentUserInfo;
    if (userInfo && userInfo.loggedIn === true && userInfo.id) {
      currentUserId = userInfo.id;
      isAuthenticated = true;
      saveAuthState();
      return true;
    }

    // Fallback: check sessionStorage (for View Transitions navigation)
    try {
      const stored = sessionStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.loggedIn && parsed.id) {
          currentUserId = parsed.id;
          isAuthenticated = true;
          // Also restore to window for other components
          window.currentUserInfo = {
            loggedIn: true,
            id: parsed.id,
            name: parsed.name,
            displayName: parsed.name
          };
          return true;
        }
      }
    } catch (e: unknown) {
      console.warn('[PlaylistModal] Could not read auth from sessionStorage:', e);
    }

    return false;
  }

  // Listen for userAuthReady event from live.astro
  document.addEventListener('userAuthReady', (e: Event) => {
    const { userInfo } = (e as CustomEvent).detail;
    if (userInfo && userInfo.loggedIn) {
      currentUserId = userInfo.id;
      isAuthenticated = true;
      saveAuthState(); // Persist for View Transitions

      // Always update UI when auth changes
      updateAuthUI();

      if (!playlistManager) {
        initPlaylist();
      } else {
        playlistManager.initialize(currentUserId || undefined, userInfo.displayName || userInfo.name);
      }
    }
  });

  // Initialize - check existing auth first, then wait if needed
  function startInitialization() {
    // Prevent duplicate initialization on same page
    if (hasInitializedThisPage) {
      return;
    }
    hasInitializedThisPage = true;

    // First check if auth is already available (from sessionStorage or window)
    if (checkExistingAuth()) {
      updateAuthUI(); // Update UI immediately with cached auth
      initPlaylist();
      return;
    }

    // Auth not ready yet, wait for it with shorter timeout
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds max wait (View Transitions should be fast)

    function checkAuth() {
      attempts++;
      const userInfo = window.currentUserInfo;

      // Check if user is logged in
      if (userInfo && userInfo.loggedIn === true && userInfo.id) {
        currentUserId = userInfo.id;
        isAuthenticated = true;
        saveAuthState(); // Persist for View Transitions
        updateAuthUI();
        initPlaylist();
        return;
      }

      // If we've waited long enough, initialize as anonymous but keep checking
      if (attempts >= maxAttempts) {
        currentUserId = null;
        isAuthenticated = false;
        updateAuthUI();
        initPlaylist();

        // Keep checking for late auth updates (every 500ms for 10 more seconds)
        let lateChecks = 0;
        const lateAuthCheck = setInterval(() => {
          lateChecks++;
          const userInfo = window.currentUserInfo;
          if (userInfo && userInfo.loggedIn === true && userInfo.id && !isAuthenticated) {
            currentUserId = userInfo.id;
            isAuthenticated = true;
            updateAuthUI();
            saveAuthState();
            clearInterval(lateAuthCheck);
          }
          if (lateChecks >= 20) { // Stop after 10 more seconds
            clearInterval(lateAuthCheck);
          }
        }, 500);
        return;
      }

      // Keep checking
      setTimeout(checkAuth, 100);
    }

    checkAuth();
  }

  // Focus trap helper for modal dialogs
  function trapFocus(modalEl: HTMLElement) {
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
    (modalEl as any)._focusTrapHandler = handler;
    modalEl.addEventListener('keydown', handler);
    firstFocusable.focus();
  }

  function removeFocusTrap(modalEl: HTMLElement) {
    const handler = (modalEl as any)._focusTrapHandler;
    if (handler) {
      modalEl.removeEventListener('keydown', handler);
      delete (modalEl as any)._focusTrapHandler;
    }
  }

  // Setup all DOM event listeners - called on every page load including View Transitions
  function setupEventListeners() {
    // Open modal
    const playlistBtn = document.getElementById('playlistBtn');
    const modal = document.getElementById('playlistModal');
    const closeBtn = document.getElementById('closePlaylistModal');
    const backdrop = modal?.querySelector('.playlist-modal-backdrop') as HTMLElement;
    let previousFocus: Element | null = null;

    // Close modal function
    function closeModal() {
      if (modal) removeFocusTrap(modal);
      modal?.classList.add('hidden');
      document.body.style.overflow = '';
      if (previousFocus && typeof (previousFocus as HTMLElement).focus === 'function') {
        (previousFocus as HTMLElement).focus();
        previousFocus = null;
      }
    }

    // Use data attributes to prevent duplicate listeners on same elements
    if (playlistBtn && !playlistBtn.dataset.listenerAttached) {
      playlistBtn.dataset.listenerAttached = 'true';
      playlistBtn.addEventListener('click', () => {
        previousFocus = document.activeElement;
        modal?.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        // Update recently played when modal opens
        updateRecentlyPlayed();
        if (modal) trapFocus(modal);
      });
    }

    if (closeBtn && !closeBtn.dataset.listenerAttached) {
      closeBtn.dataset.listenerAttached = 'true';
      closeBtn.addEventListener('click', closeModal);
    }

    if (backdrop && !backdrop.dataset.listenerAttached) {
      backdrop.dataset.listenerAttached = 'true';
      backdrop.addEventListener('click', closeModal);
    }

    // Back button (same as close)
    const backBtn = document.getElementById('backFromPlaylist');
    if (backBtn && !backBtn.dataset.listenerAttached) {
      backBtn.dataset.listenerAttached = 'true';
      backBtn.addEventListener('click', closeModal);
    }

    // Add to playlist
    const urlInput = document.getElementById('playlistUrlInput') as HTMLInputElement;
    const addBtn = document.getElementById('addToPlaylistBtn');
    const clearBtn = document.getElementById('clearPlaylistInput');
    const errorDiv = document.getElementById('playlistError');
    const successDiv = document.getElementById('playlistSuccess');

    // Show/hide clear button based on input
    if (urlInput && clearBtn) {
      urlInput.addEventListener('input', () => {
        if (urlInput.value.trim()) {
          clearBtn.classList.remove('hidden');
        } else {
          clearBtn.classList.add('hidden');
        }
      });

      clearBtn.addEventListener('click', () => {
        urlInput.value = '';
        clearBtn.classList.add('hidden');
        errorDiv?.classList.add('hidden');
        urlInput.focus();
      });
    }

    async function addToPlaylist() {
      if (!playlistManager || !urlInput) return;
      if (isAddingToPlaylist) {
        return;
      }

      const url = urlInput.value.trim();
      if (!url) return;

      isAddingToPlaylist = true;

      // Hide previous messages
      errorDiv?.classList.add('hidden');
      successDiv?.classList.add('hidden');

      try {
        const result = await playlistManager.addItem(url);

        if (result.success) {
          urlInput.value = '';
          isStopped = false;
          if (successDiv) {
            successDiv.textContent = result.message || 'Added to queue';
            successDiv.classList.remove('hidden');
            setTimeout(() => successDiv.classList.add('hidden'), 3000);
          }
        } else {
          if (errorDiv) {
            errorDiv.textContent = result.error || 'Failed to add';
            errorDiv.classList.remove('hidden');
          }
        }
      } finally {
        isAddingToPlaylist = false;
      }
    }

    if (addBtn && !addBtn.dataset.listenerAttached) {
      addBtn.dataset.listenerAttached = 'true';
      addBtn.addEventListener('click', addToPlaylist);
    }

    // Save for Later button
    const saveForLaterBtn = document.getElementById('saveForLaterBtn');
    if (saveForLaterBtn && !saveForLaterBtn.dataset.listenerAttached) {
      saveForLaterBtn.dataset.listenerAttached = 'true';
      saveForLaterBtn.addEventListener('click', async () => {
        if (!playlistManager || !urlInput) return;

        const url = urlInput.value.trim();
        if (!url) return;

        // Hide previous messages
        errorDiv?.classList.add('hidden');
        successDiv?.classList.add('hidden');

        const result = await playlistManager.addToPersonalPlaylist(url);

        if (result.success) {
          urlInput.value = '';
          clearBtn?.classList.add('hidden');
          if (successDiv) {
            successDiv.textContent = result.message || 'Saved to your playlist';
            successDiv.classList.remove('hidden');
            setTimeout(() => successDiv.classList.add('hidden'), 3000);
          }
        } else {
          if (errorDiv) {
            errorDiv.textContent = result.error || 'Failed to save';
            errorDiv.classList.remove('hidden');
          }
        }
      });
    }

    // Export Modal elements
    const exportModal = document.getElementById('exportModal');
    const exportModalBackdrop = exportModal?.querySelector('.export-modal-backdrop');
    const closeExportModal = document.getElementById('closeExportModal');
    const exportTitleInput = document.getElementById('exportTitle') as HTMLInputElement;
    const exportTrackCountEl = document.getElementById('exportTrackCount');
    const confirmExportBtn = document.getElementById('confirmExportBtn');
    const clearPlaylistBtn = document.getElementById('clearPlaylistBtn');
    const clearConfirmation = document.getElementById('clearConfirmation');
    const cancelClearBtn = document.getElementById('cancelClearBtn');
    const confirmClearBtn = document.getElementById('confirmClearBtn');
    const clearItemCountEl = document.getElementById('clearItemCount');

    // Close export modal function
    function closeExportModalFn() {
      exportModal?.classList.add('hidden');
      clearConfirmation?.classList.add('hidden');
    }

    // Export Playlist button - opens modal
    const exportPlaylistBtn = document.getElementById('exportPlaylistBtn');
    if (exportPlaylistBtn && !exportPlaylistBtn.dataset.listenerAttached) {
      exportPlaylistBtn.dataset.listenerAttached = 'true';
      exportPlaylistBtn.addEventListener('click', () => {
        if (cachedPersonalItems.length === 0) {
          const errorDiv = document.getElementById('playlistError');
          if (errorDiv) {
            errorDiv.textContent = 'No tracks to export';
            errorDiv.classList.remove('hidden');
            setTimeout(() => errorDiv.classList.add('hidden'), 3000);
          }
          return;
        }

        // Set default title and track count
        if (exportTitleInput) {
          exportTitleInput.value = 'My Fresh Wax Playlist';
        }
        if (exportTrackCountEl) {
          exportTrackCountEl.textContent = cachedPersonalItems.length.toString();
        }
        if (clearItemCountEl) {
          clearItemCountEl.textContent = cachedPersonalItems.length.toString();
        }

        // Reset clear confirmation state
        clearConfirmation?.classList.add('hidden');

        // Show modal
        exportModal?.classList.remove('hidden');
      });
    }

    // Close modal buttons
    if (closeExportModal && !closeExportModal.dataset.listenerAttached) {
      closeExportModal.dataset.listenerAttached = 'true';
      closeExportModal.addEventListener('click', closeExportModalFn);
    }
    if (exportModalBackdrop && !exportModalBackdrop.dataset.listenerAttached) {
      (exportModalBackdrop as HTMLElement).dataset.listenerAttached = 'true';
      exportModalBackdrop.addEventListener('click', closeExportModalFn);
    }

    // Confirm export button
    if (confirmExportBtn && !confirmExportBtn.dataset.listenerAttached) {
      confirmExportBtn.dataset.listenerAttached = 'true';
      confirmExportBtn.addEventListener('click', async () => {
        // Dynamic import: url-parser and constants only needed for export
        const [{ getPlatformName }, { SITE_URL }] = await Promise.all([
          import('./url-parser'),
          import('./constants')
        ]);

        const format = (document.querySelector('input[name="exportFormat"]:checked') as HTMLInputElement)?.value || 'txt';
        const title = exportTitleInput?.value.trim() || 'My Fresh Wax Playlist';
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        let content = '';
        let mimeType = 'text/plain';
        let extension = 'txt';

        // Sort items by most recently added
        const sortedItems = [...cachedPersonalItems].reverse();

        if (format === 'txt') {
          content = `${title.toUpperCase()}\n`;
          content += `${'='.repeat(title.length)}\n`;
          content += `Exported: ${dateStr} at ${timeStr}\n`;
          content += `Total Tracks: ${sortedItems.length}\n`;
          content += `${'='.repeat(title.length)}\n\n`;

          sortedItems.forEach((item, index) => {
            const num = (index + 1).toString().padStart(2, '0');
            content += `${num}. ${item.title || 'Untitled'}\n`;
            content += `    Platform: ${getPlatformName(item.platform)}\n`;
            content += `    URL: ${item.url}\n`;
            content += `    Added: ${item.addedAt ? new Date(item.addedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Unknown'}\n\n`;
          });

          content += `\n---\nExported from FRESH WAX\n${SITE_URL}\n`;
          mimeType = 'text/plain;charset=utf-8';
          extension = 'txt';

        } else if (format === 'csv') {
          content = 'Title,Platform,URL,Added Date\n';
          sortedItems.forEach((item) => {
            const csvTitle = (item.title || 'Untitled').replace(/"/g, '""');
            const csvUrl = item.url.replace(/"/g, '""');
            const addedDate = item.addedAt ? new Date(item.addedAt).toISOString().split('T')[0] : '';
            content += `"${csvTitle}","${getPlatformName(item.platform)}","${csvUrl}","${addedDate}"\n`;
          });
          mimeType = 'text/csv;charset=utf-8';
          extension = 'csv';

        } else if (format === 'pdf') {
          // Generate HTML for PDF printing with page-break control
          function escP(s: unknown) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
          const pdfHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, sans-serif;
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
      color: #222;
      line-height: 1.5;
    }
    .header { margin-bottom: 30px; }
    .brand { font-size: 28px; font-weight: 700; margin-bottom: 10px; }
    .brand-fresh { color: #222; }
    .brand-wax { color: #dc2626; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #dc2626; }
    .tracks { }
    .track {
      padding: 10px 12px;
      margin-bottom: 8px;
      background: #f9f9f9;
      border-radius: 6px;
      border-left: 3px solid #dc2626;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .track-num {
      display: inline-block;
      width: 28px;
      height: 28px;
      background: #dc2626;
      color: white;
      border-radius: 50%;
      text-align: center;
      line-height: 28px;
      font-size: 12px;
      font-weight: 600;
      margin-right: 10px;
      vertical-align: middle;
    }
    .track-title { font-weight: 600; display: inline; vertical-align: middle; }
    .track-details { margin-top: 6px; padding-left: 38px; }
    .track-meta { font-size: 12px; color: #666; }
    .track-url { font-size: 11px; color: #888; word-break: break-all; margin-top: 3px; }
    .footer {
      margin-top: 40px;
      text-align: center;
      font-size: 13px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .footer-brand { font-weight: 600; }
    .footer-fresh { color: #222; }
    .footer-wax { color: #dc2626; }
    .footer-url { color: #666; display: block; margin-top: 5px; }
    @media print {
      body { padding: 20px; }
      .track { background: #f5f5f5 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .track-num { background: #dc2626 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand"><span class="brand-fresh">Fresh</span> <span class="brand-wax">Wax</span></div>
    <div class="meta">${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} • ${sortedItems.length} tracks</div>
  </div>
  <div class="tracks">
  ${sortedItems.map((item, i) => `
    <div class="track">
      <span class="track-num">${i + 1}</span>
      <span class="track-title">${escP(item.title || 'Untitled')}</span>
      <div class="track-details">
        <div class="track-meta">${escP(getPlatformName(item.platform))}${item.addedAt ? ' &bull; Added ' + new Date(item.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</div>
        <div class="track-url">${escP(item.url)}</div>
      </div>
    </div>
  `).join('')}
  </div>
  <div class="footer">
    <div class="footer-brand"><span class="footer-fresh">Fresh</span> <span class="footer-wax">Wax</span></div>
    <span class="footer-url">freshwax.co.uk</span>
  </div>
</body>
</html>`;

          // Open in new window for printing/saving as PDF
          const printWindow = window.open('', '_blank');
          if (printWindow) {
            printWindow.document.write(pdfHTML);
            printWindow.document.close();
            printWindow.focus();
            setTimeout(() => {
              if (printWindow && !printWindow.closed) {
                printWindow.print();
              }
            }, 500);
          }

          // Close modal and show success
          closeExportModalFn();
          const successDivPdf = document.getElementById('playlistSuccess');
          if (successDivPdf) {
            successDivPdf.textContent = `Opened ${cachedPersonalItems.length} tracks for PDF export - use Print > Save as PDF`;
            successDivPdf.classList.remove('hidden');
            setTimeout(() => successDivPdf.classList.add('hidden'), 4000);
          }
          return; // Early return since we handled this case differently
        }

        // Create and download file
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `freshwax-playlist-${now.toISOString().split('T')[0]}.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Close modal and show success
        closeExportModalFn();
        const successDiv = document.getElementById('playlistSuccess');
        if (successDiv) {
          successDiv.textContent = `Exported ${cachedPersonalItems.length} tracks as ${extension.toUpperCase()}`;
          successDiv.classList.remove('hidden');
          setTimeout(() => successDiv.classList.add('hidden'), 3000);
        }
      });
    }

    // Clear playlist button - shows confirmation
    if (clearPlaylistBtn && !clearPlaylistBtn.dataset.listenerAttached) {
      clearPlaylistBtn.dataset.listenerAttached = 'true';
      clearPlaylistBtn.addEventListener('click', () => {
        clearConfirmation?.classList.remove('hidden');
      });
    }

    // Cancel clear button
    if (cancelClearBtn && !cancelClearBtn.dataset.listenerAttached) {
      cancelClearBtn.dataset.listenerAttached = 'true';
      cancelClearBtn.addEventListener('click', () => {
        clearConfirmation?.classList.add('hidden');
      });
    }

    // Confirm clear button
    if (confirmClearBtn && !confirmClearBtn.dataset.listenerAttached) {
      confirmClearBtn.dataset.listenerAttached = 'true';
      confirmClearBtn.addEventListener('click', () => {
        if (playlistManager) {
          playlistManager.clearPersonalPlaylist();
          closeExportModalFn();
        }
      });
    }

    // Back to Stream button - closes modal and returns to live stream
    const backToStreamBtn = document.getElementById('backToStreamBtn');
    if (backToStreamBtn && !backToStreamBtn.dataset.listenerAttached) {
      backToStreamBtn.dataset.listenerAttached = 'true';
      backToStreamBtn.addEventListener('click', () => {
        const modal = document.getElementById('playlistModal');
        if (modal) {
          modal.classList.add('hidden');
        }
      });
    }

    if (urlInput && !urlInput.dataset.listenerAttached) {
      urlInput.dataset.listenerAttached = 'true';
      urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          addToPlaylist();
        }
      });
    }

    // Sort dropdown
    const sortSelect = document.getElementById('playlistSortSelect') as HTMLSelectElement;
    if (sortSelect && !sortSelect.dataset.listenerAttached) {
      sortSelect.dataset.listenerAttached = 'true';
      sortSelect.addEventListener('change', () => {
        currentSortOrder = sortSelect.value as typeof currentSortOrder;
        currentPlaylistPage = 1; // Reset to first page
        renderPersonalPlaylist(cachedPersonalItems, cachedUserTracksInQueue);
      });
    }

    // Layout toggle buttons
    const layoutSingleBtn = document.getElementById('layoutSingleBtn');
    const layoutGridBtn = document.getElementById('layoutGridBtn');
    const playlistGrid = document.getElementById('myPlaylistGrid');

    if (layoutSingleBtn && !layoutSingleBtn.dataset.listenerAttached) {
      layoutSingleBtn.dataset.listenerAttached = 'true';
      layoutSingleBtn.addEventListener('click', () => {
        playlistGrid?.classList.remove('grid-mode');
        layoutSingleBtn.classList.add('active');
        layoutGridBtn?.classList.remove('active');
      });
    }

    if (layoutGridBtn && !layoutGridBtn.dataset.listenerAttached) {
      layoutGridBtn.dataset.listenerAttached = 'true';
      layoutGridBtn.addEventListener('click', () => {
        playlistGrid?.classList.add('grid-mode');
        layoutGridBtn.classList.add('active');
        layoutSingleBtn?.classList.remove('active');
      });
    }

  }

  // Listen for playlist updates (only add once, not per page load)
  function handlePlaylistUpdate(event: Event) {
    const {
      queue,
      currentIndex,
      isPlaying,
      queueSize,
      isAuthenticated: authState,
      userId,
      userQueuePosition,
      userTracksInQueue,
      isUsersTurn,
      currentDj,
      personalPlaylist,
      trackStartedAt,
      recentlyPlayed
    } = (event as CustomEvent).detail;

    // Update auth state from event
    if (authState !== undefined) {
      isAuthenticated = authState;
      currentUserId = userId || null;
      updateAuthUI();
    }

    // Update position indicator
    updatePositionIndicator(userQueuePosition, isUsersTurn, queueSize);

    // Update queue display
    renderQueue(queue, currentIndex);

    // Update controls visibility
    const controlsDiv = document.getElementById('playlistControls');
    if (queueSize > 0) {
      controlsDiv?.classList.remove('hidden');
    } else {
      controlsDiv?.classList.add('hidden');
    }

    // Update status text with current DJ
    const statusText = document.getElementById('playlistStatusText');
    if (statusText && queueSize > 0) {
      const currentItem = queue[currentIndex];
      const djName = currentDj?.userName || 'Unknown';
      statusText.textContent = `Selector: ${djName}`;
    }

    // Update Now Playing Strip
    updateNowPlayingStrip(queue, currentIndex, currentDj, trackStartedAt);

    // Update queue count
    const queueCount = document.getElementById('queueCount');
    if (queueCount) {
      queueCount.textContent = `${queueSize}/10`;
    }

    // Update stop/play state
    isStopped = !isPlaying;

    // Update personal playlist (pass count of user's tracks in queue)
    renderPersonalPlaylist(personalPlaylist || [], userTracksInQueue || 0);

    // Update recently played tracks (use Pusher data if available)
    if (recentlyPlayed && recentlyPlayed.length > 0) {
      // Use data from Pusher - no API call needed
      recentlyPlayedCache = recentlyPlayed;
      recentlyPlayedCacheTime = Date.now();
      const listContainer = document.getElementById('recentlyPlayedList');
      if (listContainer) {
        renderRecentlyPlayed(listContainer, recentlyPlayed);
      }
    } else {
      // Fallback to API fetch (initial load only)
      updateRecentlyPlayed();
    }
  }

  // Update position indicator based on user's queue position
  function updatePositionIndicator(position: number | null, isUsersTurn: boolean, queueSize: number) {
    const indicator = document.getElementById('positionIndicator');
    const positionText = document.getElementById('positionText');
    const yourTrackIndicator = document.getElementById('yourTrackIndicator');

    if (!indicator || !positionText) return;

    // Hide both indicators initially
    indicator.classList.add('hidden');
    indicator.classList.remove('your-turn');
    yourTrackIndicator?.classList.add('hidden');

    if (!isAuthenticated || position === null) {
      // User not in queue
      return;
    }

    // If it's your turn, show the new indicator above Now Playing
    if (isUsersTurn) {
      yourTrackIndicator?.classList.remove('hidden');
      return;
    }

    // Otherwise show position indicator for waiting in queue
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

  // Update Now Playing Strip
  function updateNowPlayingStrip(queue: PlaylistItem[], currentIndex: number, currentDj: Record<string, unknown> | null, trackStartedAt?: string | null) {
    const strip = document.getElementById('nowPlayingStrip');
    const title = document.getElementById('nowPlayingTitle');

    if (!strip || !title) return;

    if (queue.length === 0 || currentIndex >= queue.length) {
      strip.classList.add('hidden');
      updateVideoPreview(null, null, null);
      return;
    }

    const currentItem = queue[currentIndex];
    strip.classList.remove('hidden');
    title.textContent = currentItem?.title || 'Unknown Track';

    // Update video preview
    updateVideoPreview(currentItem, currentDj, trackStartedAt);
  }

  // Cache for global recently played to avoid excessive API calls
  let recentlyPlayedCache: PlaylistItem[] | null = null;
  let recentlyPlayedCacheTime = 0;
  const CACHE_TTL = 30000; // 30 seconds cache

  // Update Recently Played list from server (global history)
  async function updateRecentlyPlayed() {
    const listContainer = document.getElementById('recentlyPlayedList');
    if (!listContainer) return;

    // Show loading state briefly
    if (!recentlyPlayedCache) {
      listContainer.innerHTML = '<div class="recently-played-empty">Loading...</div>';
    }

    try {
      // Use cached data if fresh enough
      const now = Date.now();
      if (recentlyPlayedCache && (now - recentlyPlayedCacheTime) < CACHE_TTL) {
        renderRecentlyPlayed(listContainer, recentlyPlayedCache);
        return;
      }

      // Fetch from server API (global history)
      const response = await fetch('/api/playlist/history/');
      const result = await response.json();

      if (result.success && result.items) {
        recentlyPlayedCache = result.items.slice(0, 10);
        recentlyPlayedCacheTime = now;
        renderRecentlyPlayed(listContainer, recentlyPlayedCache);
      } else {
        listContainer.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
      }
    } catch (error: unknown) {
      console.warn('[PlaylistModal] Could not fetch recently played:', error);
      // Fallback to local history if server fails
      const localHistory = playlistManager?.getPlayHistory() || [];
      if (localHistory.length > 0) {
        renderRecentlyPlayed(listContainer, localHistory.slice(0, 10));
      } else {
        listContainer.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
      }
    }
  }

  // Render the recently played list
  function renderRecentlyPlayed(container: HTMLElement, tracks: PlaylistItem[]) {
    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
      return;
    }

    // Helper to check if title is a placeholder like "Track 1234" or similar
    function isPlaceholderTitle(title?: string): boolean {
      if (!title) return true;
      // Match various placeholder patterns
      return /^Track\s*\d+$/i.test(title) ||
             /^YouTube Video$/i.test(title) ||
             /^SoundCloud Track$/i.test(title) ||
             /^Media Track$/i.test(title) ||
             /^Unknown Track$/i.test(title);
    }

    // Extract YouTube video ID from URL
    function getYouTubeId(url: string): string | null {
      const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
      return match ? match[1] : null;
    }

    // Render initial HTML - show best available title (no async loading)
    container.innerHTML = tracks.slice(0, 10).map((track, index) => {
      let title = track.title || track.name || '';

      // If placeholder title, show a fallback
      if (isPlaceholderTitle(title)) {
        if (track.addedByName && track.addedByName !== 'Auto-Play' && track.addedByName !== 'Playlist Import') {
          title = `Track by ${track.addedByName}`;
        } else if (track.embedId) {
          // Show video ID as last resort
          title = `Video: ${track.embedId}`;
        } else {
          title = 'Unknown Track';
        }
      }

      const truncatedTitle = title.length > 40 ? title.slice(0, 40) + '...' : title;

      // Format time since played - always relative timestamp
      let timeAgo = '';
      if (track.playedAt) {
        const playedTime = new Date(track.playedAt).getTime();
        const now = Date.now();
        const diffMs = now - playedTime;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        const diffWeeks = Math.floor(diffDays / 7);

        if (diffMins < 1) {
          timeAgo = 'Just now';
        } else if (diffMins < 60) {
          timeAgo = `${diffMins}m ago`;
        } else if (diffHours < 24) {
          timeAgo = `${diffHours}h ago`;
        } else if (diffDays < 7) {
          timeAgo = `${diffDays}d ago`;
        } else {
          timeAgo = `${diffWeeks}w ago`;
        }
      }

      return `
        <div class="recently-played-item">
          <span class="recently-played-number">${index + 1}</span>
          <div class="recently-played-info">
            <span class="recently-played-title" data-track-index="${index}" title="${title}">${truncatedTitle}</span>
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
            // Use our server-side endpoint to avoid CORS issues
            const response = await fetch(`/api/youtube/title/?videoId=${videoId}`);
            if (response.ok) {
              const data = await response.json();
              if (data?.success && data.title) {
                // Find and update the DOM element
                const titleEl = container?.querySelector(`.recently-played-title[data-track-index="${index}"]`) as HTMLElement;
                if (titleEl) {
                  const truncatedTitle = data.title.length > 40 ? data.title.slice(0, 40) + '...' : data.title;
                  titleEl.textContent = truncatedTitle;
                  titleEl.setAttribute('title', data.title);
                }
                // Also update the track object in cache for future renders
                track.title = data.title;
              }
            }
          } catch (e: unknown) {
            console.warn('[PlaylistModal] Could not fetch YouTube title for', videoId, e);
          }
        }
      }
    });
  }

  // Format relative time from ISO timestamp
  function formatTimeAgo(playedAt: string): string {
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

  // Refresh all recently played time displays
  function refreshRecentlyPlayedTimes() {
    const timeElements = document.querySelectorAll('.recently-played-time[data-played-at]');
    timeElements.forEach(el => {
      const playedAt = el.getAttribute('data-played-at');
      if (playedAt) {
        el.textContent = formatTimeAgo(playedAt);
      }
    });
  }

  // Update times every minute
  let recentlyPlayedTimeInterval: number | null = null;
  function startRecentlyPlayedTimeUpdates() {
    if (recentlyPlayedTimeInterval) return;
    recentlyPlayedTimeInterval = window.setInterval(refreshRecentlyPlayedTimes, 60000);
  }

  // Start the interval
  startRecentlyPlayedTimeUpdates();

  // Helper to check if title is a placeholder
  function isPlaceholderTitleForPreview(title?: string): boolean {
    if (!title) return true;
    return /^Track\s*\d+$/i.test(title) ||
           /^YouTube Video$/i.test(title) ||
           /^SoundCloud Track$/i.test(title) ||
           /^Media Track$/i.test(title) ||
           /^Unknown Track$/i.test(title);
  }

  // Extract YouTube video ID from URL
  function getYouTubeIdForPreview(url: string): string | null {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  // Update the track info display (video player removed, just showing track details)
  function updateVideoPreview(currentItem: PlaylistItem | null, currentDj: Record<string, unknown> | null, trackStartedAt?: string | null) {
    const previewTrackInfo = document.getElementById('previewTrackInfo');
    const previewTitle = document.getElementById('previewTrackTitle');
    const previewDjName = document.getElementById('previewTrackDj');

    if (!currentItem) {
      // No track playing - show empty state
      if (previewTrackInfo) previewTrackInfo.classList.add('hidden');
      if (previewTitle) previewTitle.textContent = '--';
      if (previewDjName) previewDjName.textContent = 'Selector: --';
      stopDurationTimer();
      return;
    }

    // Update track info
    if (previewTrackInfo) previewTrackInfo.classList.remove('hidden');

    // Check if we need to fetch the real title
    const title = currentItem.title || 'Unknown Track';
    const needsFetch = isPlaceholderTitleForPreview(title) && currentItem.url;

    if (needsFetch && (currentItem.url.includes('youtube.com') || currentItem.url.includes('youtu.be'))) {
      // Show loading state first
      if (previewTitle) previewTitle.textContent = 'Loading...';

      // Fetch real title asynchronously
      const videoId = getYouTubeIdForPreview(currentItem.url);
      if (videoId) {
        fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
          .then(response => response.ok ? response.json() : null)
          .then(data => {
            if (data?.title && previewTitle) {
              previewTitle.textContent = data.title;
              // Update the item for future use
              currentItem.title = data.title;
            }
          })
          .catch(() => {
            if (previewTitle) previewTitle.textContent = title;
          });
      }
    } else {
      if (previewTitle) previewTitle.textContent = title;
    }

    if (previewDjName) previewDjName.textContent = `Selector: ${currentDj?.userName || currentItem.addedByName || 'Unknown'}`;

    // Duration timer is now handled by playlist-manager which updates previewDuration directly
    // This prevents the timer from showing elapsed time before switching to countdown
  }

  // Add playlist update listener once
  window.removeEventListener('playlistUpdate', handlePlaylistUpdate);
  window.addEventListener('playlistUpdate', handlePlaylistUpdate);

  // Cleanup function to properly destroy the playlist manager
  function cleanupPlaylistManager() {
    if (playlistManager) {
      try {
        playlistManager.destroy();
      } catch (e: unknown) {
        console.error('[PlaylistModal] Error destroying manager:', e);
      }
    }
    playlistManager = null;
    window.playlistManager = null;
    hasInitializedThisPage = false;
    listenersAttached = false;
  }

  // Cleanup when navigating away from page (View Transitions)
  function handleBeforeSwap() {
    cleanupPlaylistManager();
    // Reset the module-level guard so re-init works after navigation
    _initialized = false;
  }

  // Use Astro's page-load event for View Transitions compatibility
  // This fires on initial load AND after every View Transition navigation
  // Use a named function to prevent duplicate listeners
  function handlePageLoad() {
    // Check if we're on the live page (playlist modal exists)
    const playlistContainer = document.getElementById('playlistPlayer');
    if (!playlistContainer) {
      return;
    }

    // Clean up any existing manager first
    cleanupPlaylistManager();

    // Fresh initialization
    startInitialization();
    setupEventListeners();
  }

  // Remove existing listeners before adding (prevents duplicates across script reloads)
  document.removeEventListener('astro:before-swap', handleBeforeSwap);
  document.addEventListener('astro:before-swap', handleBeforeSwap);
  document.removeEventListener('astro:page-load', handlePageLoad);
  document.addEventListener('astro:page-load', handlePageLoad);

  // Run initialization immediately (astro:page-load may have already fired)
  // The flags will prevent duplicate work
  startInitialization();
  setupEventListeners();

  // Copy to clipboard function
  async function copyToClipboard(url: string, btn: HTMLElement) {
    try {
      await navigator.clipboard.writeText(url);
      const originalText = btn.innerHTML;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
      setTimeout(() => {
        btn.innerHTML = originalText;
      }, 2000);
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
    }
  }

  // Render queue items in compact DJ waitlist format
  function renderQueue(queue: PlaylistItem[], currentIndex: number) {
    const queueDiv = document.getElementById('playlistQueue');
    if (!queueDiv) return;

    if (queue.length === 0) {
      queueDiv.innerHTML = `
        <div class="playlist-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          <p>Playlist is empty</p>
          <p class="playlist-empty-hint">${isAuthenticated ? 'Add a track to join' : 'Sign in to join'}</p>
        </div>
      `;
      return;
    }

    queueDiv.innerHTML = queue.map((item, index) => {
      const canRemove = isAuthenticated && currentUserId && item.addedBy === currentUserId;
      const djName = item.addedByName || 'Anonymous';
      const isCurrentTrack = index === 0; // First item is always now playing
      const isUsersTrack = currentUserId && item.addedBy === currentUserId;
      const position = index + 1;

      // Position label - compact
      let positionLabel = isCurrentTrack ? '\u25B6' : `#${position}`;

      return `
        <div class="playlist-grid-item ${isCurrentTrack ? 'active' : ''} ${isUsersTrack ? 'your-track' : ''}" data-id="${item.id}">
          <div class="dj-position-badge">${positionLabel}</div>
          <div class="playlist-grid-thumb">
            ${item.thumbnail
              ? `<img src="${item.thumbnail}" alt="${item.title || 'Video'}" loading="lazy" />`
              : `<div class="playlist-grid-thumb-placeholder">
                  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>`
            }
          </div>
          <div class="playlist-grid-info">
            <div class="playlist-grid-title">${item.title || 'Untitled'}</div>
            <div class="dj-name-display">Selector: ${djName}${isUsersTrack ? ' (You)' : ''}</div>
          </div>
          <div class="playlist-grid-actions">
            ${isAuthenticated ? `
              <button class="playlist-action-btn playlist-save-btn" data-url="${item.url}" data-title="${(item.title || '').replace(/"/g, '&quot;')}" data-thumbnail="${(item.thumbnail || '').replace(/"/g, '&quot;')}" title="Save to My Playlist">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                </svg>
              </button>
            ` : ''}
            ${canRemove ? `
              <button class="playlist-action-btn playlist-remove-btn" data-id="${item.id}" title="Leave Queue">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
        if (itemId && playlistManager) {
          await playlistManager.removeItem(itemId);
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
        if (url && playlistManager) {
          const button = e.currentTarget as HTMLButtonElement;
          const originalHTML = button.innerHTML;
          button.disabled = true;
          button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning"><circle cx="12" cy="12" r="10"></circle></svg>';

          const result = await playlistManager.addToPersonalPlaylist(url, title, thumbnail);

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

  // Render personal playlist items with pagination
  function renderPersonalPlaylist(personalItems: PlaylistItem[], userTracksInQueue: number) {
    const section = document.getElementById('myPlaylistSection');
    const grid = document.getElementById('myPlaylistGrid');
    const countEl = document.getElementById('myPlaylistCount');
    const paginationEl = document.getElementById('myPlaylistPagination');

    if (!section || !grid) return;

    // Cache items for pagination
    cachedPersonalItems = personalItems;
    cachedUserTracksInQueue = userTracksInQueue;

    // Show section (always visible in column layout)
    section.classList.remove('hidden');

    // Update count
    if (countEl) {
      countEl.textContent = isAuthenticated ? personalItems.length.toString() : '0';
    }

    // Show sign-in prompt if not authenticated
    if (!isAuthenticated) {
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

    // Calculate total for pagination (before sorting, count is same)
    const totalItems = Math.min(personalItems.length, MAX_ITEMS);
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

    // Ensure current page is valid
    if (currentPlaylistPage > totalPages) {
      currentPlaylistPage = totalPages;
    }
    if (currentPlaylistPage < 1) {
      currentPlaylistPage = 1;
    }

    // Render pagination tabs if more than 20 items
    if (paginationEl) {
      if (totalItems > ITEMS_PER_PAGE) {
        paginationEl.classList.remove('hidden');
        let paginationHTML = '';
        for (let i = 1; i <= totalPages; i++) {
          const startItem = (i - 1) * ITEMS_PER_PAGE + 1;
          const endItem = Math.min(i * ITEMS_PER_PAGE, totalItems);
          paginationHTML += `
            <button class="playlist-page-btn ${i === currentPlaylistPage ? 'active' : ''}" data-page="${i}">
              ${startItem}-${endItem}
            </button>
          `;
        }
        paginationEl.innerHTML = paginationHTML;

        // Add click listeners for pagination buttons
        // Important: Don't capture sortedItems in closure - recalculate on click
        paginationEl.querySelectorAll('.playlist-page-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const page = parseInt((e.currentTarget as HTMLElement).dataset.page || '1', 10);
            if (page !== currentPlaylistPage) {
              currentPlaylistPage = page;
              // Re-sort items with current sort order to ensure consistency
              const freshSortedItems = sortPersonalItems(cachedPersonalItems, currentSortOrder);
              renderPersonalPlaylistPage(freshSortedItems, cachedUserTracksInQueue);
              // Update active state
              paginationEl.querySelectorAll('.playlist-page-btn').forEach(b => b.classList.remove('active'));
              (e.currentTarget as HTMLElement).classList.add('active');
            }
          });
        });
      } else {
        paginationEl.classList.add('hidden');
      }
    }

    // Sort and render the current page
    const sortedItems = sortPersonalItems(personalItems, currentSortOrder);
    renderPersonalPlaylistPage(sortedItems, userTracksInQueue);
  }

  // Render a specific page of the personal playlist
  function renderPersonalPlaylistPage(sortedItems: PlaylistItem[], userTracksInQueue: number) {
    const grid = document.getElementById('myPlaylistGrid');
    if (!grid) return;

    const startIndex = (currentPlaylistPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, sortedItems.length, MAX_ITEMS);
    const pageItems = sortedItems.slice(startIndex, endIndex);

    grid.innerHTML = pageItems.map((item) => `
      <div class="personal-playlist-item" data-id="${item.id}">
        <div class="personal-item-thumb">
          ${item.thumbnail
            ? `<img src="${item.thumbnail}" alt="${item.title || 'Track'}" loading="lazy" />`
            : `<svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(139,92,246,0.5)"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
          }
        </div>
        <div class="personal-item-info">
          <div class="personal-item-title">${item.title || 'Untitled'}</div>
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
          <button class="personal-delete-btn" data-id="${item.id}" title="Remove from playlist">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
        if (itemId && playlistManager) {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          btn.textContent = '...';

          const result = await playlistManager.addPersonalItemToQueue(itemId);

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
        if (!itemId || !playlistManager) return;

        // Check if already showing confirmation
        if (button.classList.contains('confirming')) {
          // Second click - confirm delete
          playlistManager.removeFromPersonalPlaylist(itemId);
          return;
        }

        // First click - show confirmation state
        button.classList.add('confirming');
        const originalHTML = button.innerHTML;
        button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        button.title = 'Click again to confirm';

        // Reset after 3 seconds if not confirmed
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
}
