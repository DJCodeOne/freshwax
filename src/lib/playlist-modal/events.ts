// src/lib/playlist-modal/events.ts
// Event handlers and initialization logic for the playlist modal.

import { createClientLogger } from '../client-logger';
import type { PlaylistItem, PlaylistModalState, SortOrder } from './types';
import {
  trapFocus,
  removeFocusTrap,
  updateAuthUI,
  updatePositionIndicator,
  updateNowPlayingStrip,
  renderQueue,
  renderRecentlyPlayed,
  renderPersonalPlaylist,
  sortPersonalItems,
  startRecentlyPlayedTimeUpdates,
  stopRecentlyPlayedTimeUpdates,
} from './dom';
import {
  initPlaylist,
  saveAuthState,
  checkExistingAuth,
  updateRecentlyPlayed,
} from './api';

const log = createClientLogger('PlaylistModal');

// ─── Playlist update handler ────────────────────────────────────────────────

/** Handle playlistUpdate custom events from the playlist manager */
export function handlePlaylistUpdate(state: PlaylistModalState, event: Event) {
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

  if (authState !== undefined) {
    state.isAuthenticated = authState;
    state.currentUserId = userId || null;
    updateAuthUI(state);
  }

  updatePositionIndicator(state, userQueuePosition, isUsersTurn, queueSize);
  renderQueue(state, queue, currentIndex);

  const controlsDiv = document.getElementById('playlistControls');
  if (queueSize > 0) {
    controlsDiv?.classList.remove('hidden');
  } else {
    controlsDiv?.classList.add('hidden');
  }

  const statusText = document.getElementById('playlistStatusText');
  if (statusText && queueSize > 0) {
    const currentItem = queue[currentIndex];
    const djName = currentDj?.userName || 'Unknown';
    statusText.textContent = `Selector: ${djName}`;
  }

  updateNowPlayingStrip(state, queue, currentIndex, currentDj, trackStartedAt);

  const queueCount = document.getElementById('queueCount');
  if (queueCount) {
    queueCount.textContent = `${queueSize}/10`;
  }

  state.isStopped = !isPlaying;
  renderPersonalPlaylist(state, personalPlaylist || [], userTracksInQueue || 0);

  if (recentlyPlayed && recentlyPlayed.length > 0) {
    state.recentlyPlayedCache = recentlyPlayed;
    state.recentlyPlayedCacheTime = Date.now();
    const listContainer = document.getElementById('recentlyPlayedList');
    if (listContainer) {
      renderRecentlyPlayed(listContainer, recentlyPlayed);
    }
  } else {
    updateRecentlyPlayed(state);
  }
}

// ─── Event listener setup ───────────────────────────────────────────────────

/** Setup all DOM event listeners -- called on every page load including View Transitions */
export function setupEventListeners(state: PlaylistModalState) {
  const playlistBtn = document.getElementById('playlistBtn');
  const modal = document.getElementById('playlistModal');
  const closeBtn = document.getElementById('closePlaylistModal');
  const backdrop = modal?.querySelector('.playlist-modal-backdrop') as HTMLElement;
  let previousFocus: Element | null = null;

  function closeModal() {
    if (modal) removeFocusTrap(modal);
    modal?.classList.add('hidden');
    document.body.style.overflow = '';
    stopRecentlyPlayedTimeUpdates(state);
    if (previousFocus && typeof (previousFocus as HTMLElement).focus === 'function') {
      (previousFocus as HTMLElement).focus();
      previousFocus = null;
    }
  }

  if (playlistBtn && !playlistBtn.dataset.listenerAttached) {
    playlistBtn.dataset.listenerAttached = 'true';
    playlistBtn.addEventListener('click', () => {
      previousFocus = document.activeElement;
      modal?.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      updateRecentlyPlayed(state);
      startRecentlyPlayedTimeUpdates(state);
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

  const backBtn = document.getElementById('backFromPlaylist');
  if (backBtn && !backBtn.dataset.listenerAttached) {
    backBtn.dataset.listenerAttached = 'true';
    backBtn.addEventListener('click', closeModal);
  }

  document.addEventListener('keydown', function(e: KeyboardEvent) {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  // ─── Add to playlist ──────────────────────────────────────────────────

  const urlInput = document.getElementById('playlistUrlInput') as HTMLInputElement;
  const addBtn = document.getElementById('addToPlaylistBtn');
  const clearBtn = document.getElementById('clearPlaylistInput');
  const errorDiv = document.getElementById('playlistError');
  const successDiv = document.getElementById('playlistSuccess');

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
    if (!state.playlistManager || !urlInput) return;
    if (state.isAddingToPlaylist) return;

    const url = urlInput.value.trim();
    if (!url) return;

    state.isAddingToPlaylist = true;

    errorDiv?.classList.add('hidden');
    successDiv?.classList.add('hidden');

    try {
      const result = await state.playlistManager.addItem(url);

      if (result.success) {
        urlInput.value = '';
        state.isStopped = false;
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
      state.isAddingToPlaylist = false;
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
      if (!state.playlistManager || !urlInput) return;

      const url = urlInput.value.trim();
      if (!url) return;

      errorDiv?.classList.add('hidden');
      successDiv?.classList.add('hidden');

      const result = await state.playlistManager.addToPersonalPlaylist(url);

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

  // ─── Export modal ─────────────────────────────────────────────────────

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

  function closeExportModalFn() {
    exportModal?.classList.add('hidden');
    clearConfirmation?.classList.add('hidden');
  }

  const exportPlaylistBtn = document.getElementById('exportPlaylistBtn');
  if (exportPlaylistBtn && !exportPlaylistBtn.dataset.listenerAttached) {
    exportPlaylistBtn.dataset.listenerAttached = 'true';
    exportPlaylistBtn.addEventListener('click', () => {
      if (state.cachedPersonalItems.length === 0) {
        const errorDiv = document.getElementById('playlistError');
        if (errorDiv) {
          errorDiv.textContent = 'No tracks to export';
          errorDiv.classList.remove('hidden');
          setTimeout(() => errorDiv.classList.add('hidden'), 3000);
        }
        return;
      }

      if (exportTitleInput) {
        exportTitleInput.value = 'My Fresh Wax Playlist';
      }
      if (exportTrackCountEl) {
        exportTrackCountEl.textContent = state.cachedPersonalItems.length.toString();
      }
      if (clearItemCountEl) {
        clearItemCountEl.textContent = state.cachedPersonalItems.length.toString();
      }

      clearConfirmation?.classList.add('hidden');
      exportModal?.classList.remove('hidden');
    });
  }

  if (closeExportModal && !closeExportModal.dataset.listenerAttached) {
    closeExportModal.dataset.listenerAttached = 'true';
    closeExportModal.addEventListener('click', closeExportModalFn);
  }
  if (exportModalBackdrop && !exportModalBackdrop.dataset.listenerAttached) {
    (exportModalBackdrop as HTMLElement).dataset.listenerAttached = 'true';
    exportModalBackdrop.addEventListener('click', closeExportModalFn);
  }

  if (confirmExportBtn && !confirmExportBtn.dataset.listenerAttached) {
    confirmExportBtn.dataset.listenerAttached = 'true';
    confirmExportBtn.addEventListener('click', async () => {
      const [{ getPlatformName }, { SITE_URL }] = await Promise.all([
        import('../url-parser'),
        import('../constants')
      ]);

      const format = (document.querySelector('input[name="exportFormat"]:checked') as HTMLInputElement)?.value || 'txt';
      const title = exportTitleInput?.value.trim() || 'My Fresh Wax Playlist';
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      let content = '';
      let mimeType = 'text/plain';
      let extension = 'txt';

      const sortedItems = [...state.cachedPersonalItems].reverse();

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

        closeExportModalFn();
        const successDivPdf = document.getElementById('playlistSuccess');
        if (successDivPdf) {
          successDivPdf.textContent = `Opened ${state.cachedPersonalItems.length} tracks for PDF export - use Print > Save as PDF`;
          successDivPdf.classList.remove('hidden');
          setTimeout(() => successDivPdf.classList.add('hidden'), 4000);
        }
        return;
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

      closeExportModalFn();
      const successDiv = document.getElementById('playlistSuccess');
      if (successDiv) {
        successDiv.textContent = `Exported ${state.cachedPersonalItems.length} tracks as ${extension.toUpperCase()}`;
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

  if (cancelClearBtn && !cancelClearBtn.dataset.listenerAttached) {
    cancelClearBtn.dataset.listenerAttached = 'true';
    cancelClearBtn.addEventListener('click', () => {
      clearConfirmation?.classList.add('hidden');
    });
  }

  if (confirmClearBtn && !confirmClearBtn.dataset.listenerAttached) {
    confirmClearBtn.dataset.listenerAttached = 'true';
    confirmClearBtn.addEventListener('click', () => {
      if (state.playlistManager) {
        state.playlistManager.clearPersonalPlaylist();
        closeExportModalFn();
      }
    });
  }

  // Back to Stream button
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
      state.currentSortOrder = sortSelect.value as SortOrder;
      state.currentPlaylistPage = 1;
      renderPersonalPlaylist(state, state.cachedPersonalItems, state.cachedUserTracksInQueue);
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

// ─── Initialization flow ────────────────────────────────────────────────────

/** Start initialization -- check existing auth first, then wait if needed */
export function startInitialization(state: PlaylistModalState) {
  if (state.hasInitializedThisPage) return;
  state.hasInitializedThisPage = true;

  if (checkExistingAuth(state)) {
    updateAuthUI(state);
    initPlaylist(state);
    return;
  }

  let attempts = 0;
  const maxAttempts = 30;

  function checkAuth() {
    attempts++;
    const userInfo = window.currentUserInfo;

    if (userInfo && userInfo.loggedIn === true && userInfo.id) {
      state.currentUserId = userInfo.id;
      state.isAuthenticated = true;
      saveAuthState(state);
      updateAuthUI(state);
      initPlaylist(state);
      return;
    }

    if (attempts >= maxAttempts) {
      state.currentUserId = null;
      state.isAuthenticated = false;
      updateAuthUI(state);
      initPlaylist(state);

      let lateChecks = 0;
      const lateAuthCheck = setInterval(() => {
        lateChecks++;
        const userInfo = window.currentUserInfo;
        if (userInfo && userInfo.loggedIn === true && userInfo.id && !state.isAuthenticated) {
          state.currentUserId = userInfo.id;
          state.isAuthenticated = true;
          updateAuthUI(state);
          saveAuthState(state);
          clearInterval(lateAuthCheck);
        }
        if (lateChecks >= 20) {
          clearInterval(lateAuthCheck);
        }
      }, 500);
      return;
    }

    setTimeout(checkAuth, 100);
  }

  checkAuth();
}

/** Cleanup function to properly destroy the playlist manager */
export function cleanupPlaylistManager(state: PlaylistModalState) {
  stopRecentlyPlayedTimeUpdates(state);
  if (state.playlistManager) {
    try {
      state.playlistManager.destroy();
    } catch (e: unknown) {
      log.error('Error destroying manager:', e);
    }
  }
  state.playlistManager = null;
  window.playlistManager = null;
  state.hasInitializedThisPage = false;
  state.listenersAttached = false;
}
