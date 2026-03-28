// src/lib/playlist-modal/dom-render.ts
// Queue and personal playlist rendering for the playlist modal.

import { escapeHtml } from '../escape-html';
import { TIMEOUTS } from '../timeouts';
import {
  ITEMS_PER_PAGE,
  MAX_PLAYLIST_ITEMS,
} from '../constants/limits';
import type { PlaylistItem, ModalState } from './types';
import {
  platformName,
  formatAddedDate,
  formatTimeAgo,
  sortPersonalItems,
  isPlaceholderTitle,
  getYouTubeId,
} from './dom-format';
import { copyToClipboard } from './dom-state';

// ---------------------------------------------------------------------------
// Queue & personal playlist rendering
// ---------------------------------------------------------------------------

/** Render queue items in compact DJ waitlist format */
export function renderQueue(
  state: ModalState,
  queue: PlaylistItem[],
  currentIndex: number,
): void {
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
        await copyToClipboard(state, url, e.currentTarget as HTMLElement);
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
      // Clean title — remove [videoId] suffix if present
      let title = el.dataset.title;
      if (title) title = title.replace(/\s*\[[a-zA-Z0-9_-]{11}\]/, '').trim();
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
            setTimeout(() => successDiv.classList.add('hidden'), TIMEOUTS.TOAST);
          }
        } else {
          button.innerHTML = originalHTML;
          button.disabled = false;
          const errorDiv = document.getElementById('playlistError');
          if (errorDiv) {
            errorDiv.textContent = result.error || 'Failed to save';
            errorDiv.classList.remove('hidden');
            setTimeout(() => errorDiv.classList.add('hidden'), TIMEOUTS.TOAST_LONG);
          }
        }
      }
    });
  });
}

/** Render the recently played list */
export function renderRecentlyPlayed(
  state: ModalState,
  container: HTMLElement,
  tracks: PlaylistItem[],
): void {
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
          const titleController = new AbortController();
          const titleTimeoutId = setTimeout(() => titleController.abort(), TIMEOUTS.API_EXTENDED);

          const response = await fetch(`/api/youtube/title/?videoId=${videoId}`, {
            signal: titleController.signal
          });
          clearTimeout(titleTimeoutId);

          if (response.ok) {
            const data = await response.json();
            if (data?.success && data.title) {
              const titleEl = container?.querySelector(`.recently-played-title[data-track-index="${index}"]`) as HTMLElement;
              if (titleEl) {
                const truncTitle = data.title.length > 40 ? data.title.slice(0, 40) + '...' : data.title;
                titleEl.textContent = truncTitle;
                titleEl.setAttribute('title', data.title);
              }
              track.title = data.title;
            }
          }
        } catch (e: unknown) {
          state.log.warn('Could not fetch YouTube title for', videoId, e);
        }
      }
    }
  });
}

/** Render personal playlist items with pagination */
export function renderPersonalPlaylist(
  state: ModalState,
  personalItems: PlaylistItem[],
  userTracksInQueue: number,
): void {
  const section = document.getElementById('myPlaylistSection');
  const grid = document.getElementById('myPlaylistGrid');
  const countEl = document.getElementById('myPlaylistCount');
  const paginationEl = document.getElementById('myPlaylistPagination');

  if (!section || !grid) return;

  state.cachedPersonalItems = personalItems;
  state.cachedUserTracksInQueue = userTracksInQueue;

  const MAX_ITEMS = MAX_PLAYLIST_ITEMS;

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
export function renderPersonalPlaylistPage(
  state: ModalState,
  sortedItems: PlaylistItem[],
  userTracksInQueue: number,
): void {
  const grid = document.getElementById('myPlaylistGrid');
  if (!grid) return;

  const MAX_ITEMS = MAX_PLAYLIST_ITEMS;
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
          <span class="personal-item-platform">${platformName(item.platform, item.url, item.title)}</span>
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
            setTimeout(() => successDiv.classList.add('hidden'), TIMEOUTS.TOAST);
          }
        } else {
          const errorDiv = document.getElementById('playlistError');
          if (errorDiv) {
            errorDiv.textContent = result.error || 'Failed to add';
            errorDiv.classList.remove('hidden');
            setTimeout(() => errorDiv.classList.add('hidden'), TIMEOUTS.TOAST_LONG);
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
      if (!itemId || !state.playlistManager || button.classList.contains('deleting')) return;

      if (!confirm('Remove this track from your playlist?')) return;

      button.classList.add('deleting');
      button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      state.playlistManager.removeFromPersonalPlaylist(itemId);
    });
  });
}
