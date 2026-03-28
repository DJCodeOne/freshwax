// src/lib/playlist-modal/dom-modal.ts
// Modal HTML injection for the playlist modal.

/** Inject the full modal HTML into the #playlistModal container. */
export function injectModalHTML(): void {
  const container = document.getElementById('playlistModal');
  if (!container) return;

  const isMobile = window.innerWidth <= 768;
  const mobileWrap = isMobile ? 'style="width:100%;max-width:100vw;overflow-x:hidden;box-sizing:border-box;"' : '';
  const mobileBody = isMobile ? 'style="width:100%;max-width:100vw;overflow-x:hidden;overflow-y:auto;box-sizing:border-box;padding:0.75rem;"' : '';
  const mobileCols = isMobile ? 'style="display:flex;flex-direction:column;gap:1rem;width:100%;max-width:100%;overflow:visible;"' : '';
  const mobileCol = isMobile ? 'style="width:100%;max-width:100%;overflow:visible;padding:0;border:none;"' : '';

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
