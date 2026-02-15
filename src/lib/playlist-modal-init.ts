// src/lib/playlist-modal-init.ts
// Lazy-loaded playlist modal initialization module.
// Extracted from PlaylistModal.astro <script> to enable dynamic import
// and reduce initial JS payload on the live page (~20KB gzipped savings).

import { PlaylistManager } from './playlist-manager';
import { getPlatformName } from './url-parser';

// Guard against multiple initializations
let _initialized = false;

export function initPlaylistModal() {
  if (_initialized) return;
  _initialized = true;

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
      } catch (error) {
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
  let cachedPersonalItems: any[] = [];
  let cachedUserTracksInQueue = 0;
  let currentSortOrder: 'recent' | 'oldest' | 'alpha-az' | 'alpha-za' = 'recent';

  // Sort personal playlist items
  function sortPersonalItems(items: any[], sortOrder: string): any[] {
    const sorted = [...items];
    switch (sortOrder) {
      case 'recent':
        // Most recent first (reverse of original order which is oldest first)
        return sorted.reverse();
      case 'oldest':
        // Oldest first (original order)
        return sorted;
      case 'alpha-az':
        return sorted.sort((a: any, b: any) => (a.title || '').localeCompare(b.title || ''));
      case 'alpha-za':
        return sorted.sort((a: any, b: any) => (b.title || '').localeCompare(a.title || ''));
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
    const userInfo = (window as any).currentUserInfo;
    currentUserId = userInfo?.id || null;
    isAuthenticated = userInfo?.loggedIn || false;

    console.log('[PlaylistModal] Init with userInfo:', userInfo);

    playlistManager = new PlaylistManager('playlistPlayer');
    await playlistManager.initialize(currentUserId || undefined, userInfo?.displayName || userInfo?.name);

    // Update UI based on auth state
    updateAuthUI();

    // Expose globally for live-stream.js
    (window as any).playlistManager = playlistManager;
    console.log('[PlaylistModal] Manager initialized, authenticated:', isAuthenticated);
  }

  // Update UI based on authentication state
  function updateAuthUI() {
    const authNotice = document.getElementById('playlistAuthNotice');
    const inputGroup = document.getElementById('playlistInputGroup');

    console.log('[PlaylistModal] updateAuthUI, isAuthenticated:', isAuthenticated, 'authNotice:', !!authNotice, 'inputGroup:', !!inputGroup);

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
      const userInfo = (window as any).currentUserInfo;
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
    const userInfo = (window as any).currentUserInfo;
    if (userInfo && userInfo.loggedIn === true && userInfo.id) {
      console.log('[PlaylistModal] Auth from window.currentUserInfo:', userInfo);
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
          console.log('[PlaylistModal] Auth from sessionStorage:', parsed);
          currentUserId = parsed.id;
          isAuthenticated = true;
          // Also restore to window for other components
          (window as any).currentUserInfo = {
            loggedIn: true,
            id: parsed.id,
            name: parsed.name,
            displayName: parsed.name
          };
          return true;
        }
      }
    } catch (e) {
      console.warn('[PlaylistModal] Could not read auth from sessionStorage:', e);
    }

    return false;
  }

  // Listen for userAuthReady event from live.astro
  document.addEventListener('userAuthReady', (e: any) => {
    const { userInfo } = e.detail;
    console.log('[PlaylistModal] userAuthReady event received:', userInfo);

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
      console.log('[PlaylistModal] Already initialized, skipping');
      return;
    }
    hasInitializedThisPage = true;
    console.log('[PlaylistModal] startInitialization called');

    // First check if auth is already available (from sessionStorage or window)
    if (checkExistingAuth()) {
      console.log('[PlaylistModal] Using existing auth from storage/window');
      updateAuthUI(); // Update UI immediately with cached auth
      initPlaylist();
      return;
    }

    // Auth not ready yet, wait for it with shorter timeout
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds max wait (View Transitions should be fast)

    function checkAuth() {
      attempts++;
      const userInfo = (window as any).currentUserInfo;

      // Check if user is logged in
      if (userInfo && userInfo.loggedIn === true && userInfo.id) {
        console.log('[PlaylistModal] Auth ready after', attempts * 100, 'ms:', userInfo);
        currentUserId = userInfo.id;
        isAuthenticated = true;
        saveAuthState(); // Persist for View Transitions
        updateAuthUI();
        initPlaylist();
        return;
      }

      // If we've waited long enough, initialize as anonymous but keep checking
      if (attempts >= maxAttempts) {
        console.log('[PlaylistModal] Auth timeout after 3s, initializing as anonymous');
        currentUserId = null;
        isAuthenticated = false;
        updateAuthUI();
        initPlaylist();

        // Keep checking for late auth updates (every 500ms for 10 more seconds)
        let lateChecks = 0;
        const lateAuthCheck = setInterval(() => {
          lateChecks++;
          const userInfo = (window as any).currentUserInfo;
          if (userInfo && userInfo.loggedIn === true && userInfo.id && !isAuthenticated) {
            console.log('[PlaylistModal] Late auth detected after', (3000 + lateChecks * 500), 'ms:', userInfo);
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

  // Setup all DOM event listeners - called on every page load including View Transitions
  function setupEventListeners() {
    console.log('[PlaylistModal] Setting up event listeners');

    // Open modal
    const playlistBtn = document.getElementById('playlistBtn');
    const modal = document.getElementById('playlistModal');
    const closeBtn = document.getElementById('closePlaylistModal');
    const backdrop = modal?.querySelector('.playlist-modal-backdrop') as HTMLElement;

    // Close modal function
    function closeModal() {
      modal?.classList.add('hidden');
      document.body.style.overflow = '';
    }

    // Use data attributes to prevent duplicate listeners on same elements
    if (playlistBtn && !playlistBtn.dataset.listenerAttached) {
      playlistBtn.dataset.listenerAttached = 'true';
      playlistBtn.addEventListener('click', () => {
        console.log('[PlaylistModal] Playlist button clicked');
        modal?.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        // Update recently played when modal opens
        updateRecentlyPlayed();
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
        console.log('[PlaylistModal] Already adding, ignoring duplicate request');
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
      confirmExportBtn.addEventListener('click', () => {
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

          sortedItems.forEach((item: any, index: number) => {
            const num = (index + 1).toString().padStart(2, '0');
            content += `${num}. ${item.title || 'Untitled'}\n`;
            content += `    Platform: ${getPlatformName(item.platform)}\n`;
            content += `    URL: ${item.url}\n`;
            content += `    Added: ${item.addedAt ? new Date(item.addedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Unknown'}\n\n`;
          });

          content += `\n---\nExported from FRESH WAX\nhttps://freshwax.co.uk\n`;
          mimeType = 'text/plain;charset=utf-8';
          extension = 'txt';

        } else if (format === 'csv') {
          content = 'Title,Platform,URL,Added Date\n';
          sortedItems.forEach((item: any) => {
            const csvTitle = (item.title || 'Untitled').replace(/"/g, '""');
            const csvUrl = item.url.replace(/"/g, '""');
            const addedDate = item.addedAt ? new Date(item.addedAt).toISOString().split('T')[0] : '';
            content += `"${csvTitle}","${getPlatformName(item.platform)}","${csvUrl}","${addedDate}"\n`;
          });
          mimeType = 'text/csv;charset=utf-8';
          extension = 'csv';

        } else if (format === 'pdf') {
          // Generate HTML for PDF printing with page-break control
          function escP(s: any) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
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
  ${sortedItems.map((item: any, i: number) => `
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
            setTimeout(() => printWindow.print(), 500);
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
  function handlePlaylistUpdate(event: any) {
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
    } = event.detail;

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
    console.log('[PlaylistModal] Received personalPlaylist:', personalPlaylist ? personalPlaylist.length : 'undefined');
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
  function updateNowPlayingStrip(queue: any[], currentIndex: number, currentDj: any, trackStartedAt?: string | null) {
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
  let recentlyPlayedCache: any[] | null = null;
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
    } catch (error) {
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
  function renderRecentlyPlayed(container: HTMLElement, tracks: any[]) {
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
    container.innerHTML = tracks.slice(0, 10).map((track: any, index: number) => {
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
    tracks.slice(0, 10).forEach(async (track: any, index: number) => {
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
              if (data.success && data.title) {
                // Find and update the DOM element
                const titleEl = container.querySelector(`.recently-played-title[data-track-index="${index}"]`) as HTMLElement;
                if (titleEl) {
                  const truncatedTitle = data.title.length > 40 ? data.title.slice(0, 40) + '...' : data.title;
                  titleEl.textContent = truncatedTitle;
                  titleEl.setAttribute('title', data.title);
                }
                // Also update the track object in cache for future renders
                track.title = data.title;
              }
            }
          } catch (e) {
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
  function updateVideoPreview(currentItem: any, currentDj: any, trackStartedAt?: string | null) {
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
      console.log('[PlaylistModal] Destroying old playlist manager');
      try {
        playlistManager.destroy();
      } catch (e) {
        console.error('[PlaylistModal] Error destroying manager:', e);
      }
    }
    playlistManager = null;
    (window as any).playlistManager = null;
    hasInitializedThisPage = false;
    listenersAttached = false;
  }

  // Cleanup when navigating away from page (View Transitions)
  function handleBeforeSwap() {
    console.log('[PlaylistModal] astro:before-swap - cleaning up');
    cleanupPlaylistManager();
    // Reset the module-level guard so re-init works after navigation
    _initialized = false;
  }

  // Use Astro's page-load event for View Transitions compatibility
  // This fires on initial load AND after every View Transition navigation
  // Use a named function to prevent duplicate listeners
  function handlePageLoad() {
    console.log('[PlaylistModal] astro:page-load event fired');

    // Check if we're on the live page (playlist modal exists)
    const playlistContainer = document.getElementById('playlistPlayer');
    if (!playlistContainer) {
      console.log('[PlaylistModal] Not on live page, skipping initialization');
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
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Render queue items in compact DJ waitlist format
  function renderQueue(queue: any[], currentIndex: number) {
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

    queueDiv.innerHTML = queue.map((item: any, index: number) => {
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
  function renderPersonalPlaylist(personalItems: any[], userTracksInQueue: number) {
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
  function renderPersonalPlaylistPage(sortedItems: any[], userTracksInQueue: number) {
    const grid = document.getElementById('myPlaylistGrid');
    if (!grid) return;

    const startIndex = (currentPlaylistPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, sortedItems.length, MAX_ITEMS);
    const pageItems = sortedItems.slice(startIndex, endIndex);

    grid.innerHTML = pageItems.map((item: any) => `
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
            <span class="personal-item-platform">${getPlatformName(item.platform)}</span>
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
