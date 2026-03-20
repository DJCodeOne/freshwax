import { escapeHtml } from './escape-html';

// ============================================
// UNIFIED CACHE SYSTEM - API FRIENDLY
// Extended TTLs to reduce API calls
// ============================================
var FWCache = {
  PREFIX: 'fwx_',
  TTL: {
    RATINGS: 30 * 60 * 1000,      // 30 minutes (was 15)
    COMMENTS: 10 * 60 * 1000,     // 10 minutes (was 5)
    USER_RATING: 120 * 60 * 1000, // 2 hours (was 1)
    OWNERSHIP: 60 * 60 * 1000     // 1 hour - session cache for ownership checks
  },

  get: function(key) {
    try {
      var cached = localStorage.getItem(this.PREFIX + key);
      if (!cached) return null;
      var data = JSON.parse(cached);
      var ttl = data.ttl || this.TTL.RATINGS;
      if (Date.now() - data.ts > ttl) {
        localStorage.removeItem(this.PREFIX + key);
        return null;
      }
      return data.v;
    } catch (e){ return null; }
  },

  set: function(key, value, ttl) {
    try {
      localStorage.setItem(this.PREFIX + key, JSON.stringify({
        v: value,
        ts: Date.now(),
        ttl: ttl || this.TTL.RATINGS
      }));
    } catch (e){
      this.cleanup();
    }
  },

  update: function(key, updateFn) {
    var current = this.get(key) || {};
    var updated = updateFn(current);
    this.set(key, updated);
    return updated;
  },

  remove: function(key) {
    try { localStorage.removeItem(this.PREFIX + key); } catch (e){}
  },

  cleanup: function() {
    try {
      var keysToRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.startsWith(this.PREFIX)) {
          var cached = localStorage.getItem(key);
          if (cached) {
            var data = JSON.parse(cached);
            if (Date.now() - data.ts > (data.ttl || this.TTL.RATINGS)) {
              keysToRemove.push(key);
            }
          }
        }
      }
      keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
    } catch (e){}
  }
};

// ============================================
// AUTH HELPER - Wait for auth to be ready
// ============================================
async function getAuthUser() {
  // Check localStorage cache first for instant auth (prevents race condition)
  try {
    const cached = sessionStorage.getItem('fw_auth_cache');
    if (cached) {
      const cachedAuth = JSON.parse(cached);
      if (cachedAuth && cachedAuth.id && cachedAuth.timestamp) {
        // Cache valid for 30 minutes
        if (Date.now() - cachedAuth.timestamp < 1800000) {
          // Return a minimal user object with uid from cache
          return { uid: cachedAuth.id, displayName: cachedAuth.displayName || cachedAuth.name };
        }
      }
    }
  } catch (e){ /* ignore cache errors */ }

  // If authReady promise exists (from Header), wait for it with timeout
  if (window.authReady) {
    try {
      await Promise.race([
        window.authReady,
        new Promise((_, reject) => setTimeout(() => reject('timeout'), 3000))
      ]);
    } catch (e){
      // Timeout - check cache again or Firebase directly
    }
  }
  // Return the authenticated user
  return window.firebaseAuth?.currentUser || window.authUser || null;
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function sanitizeComment(text) {
  return text
    .replace(/https?:\/\/[^\s]+/gi, '[link removed]')
    .replace(/www\.[^\s]+/gi, '[link removed]')
    .replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/gi, '[email removed]')
    .replace(/<[^>]*>/g, '')
    .trim()
    .substring(0, 300);
}


function formatDate(timestamp) {
  var date = new Date(timestamp);
  var now = new Date();
  var diff = now - date;
  var minutes = Math.floor(diff / 60000);
  var hours = Math.floor(diff / 3600000);
  var days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + 'm ago';
  if (hours < 24) return hours + 'h ago';
  if (days < 7) return days + 'd ago';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ============================================
// RATING SYSTEM - OPTIMIZED FOR API QUOTA
// - Uses server-side ratings when available
// - Extended debounce (2s) prevents spam
// - Batch requests only for missing ratings
// ============================================
var ratingDebounce = {};
var pendingRatingsRequest = null;

function initRatingSystem() {
  var releaseCards = document.querySelectorAll('[data-release]');
  var needsFetch = [];

  releaseCards.forEach(function(card) {
    if (card.hasAttribute('data-ratings-init')) return;
    card.setAttribute('data-ratings-init', 'true');

    var id = card.getAttribute('data-release');
    if (!id) return;

    // Skip API call if server already provided ratings
    var hasServerRatings = card.getAttribute('data-has-server-ratings') === 'true';
    if (hasServerRatings) return;

    // Check cache first
    var cached = FWCache.get('ratings');
    if (cached && cached[id]) {
      updateSingleRatingUI(card, id, cached[id]);
    } else {
      needsFetch.push(id);
    }
  });

  // Only fetch if we have missing ratings
  if (needsFetch.length === 0) {
    setupRatingClickHandlers();
    return;
  }

  // Reuse pending request if exists
  if (pendingRatingsRequest) {
    pendingRatingsRequest.then(function(ratings) {
      releaseCards.forEach(function(card) {
        var id = card.getAttribute('data-release');
        if (ratings && ratings[id]) {
          updateSingleRatingUI(card, id, ratings[id]);
        }
      });
    });
    setupRatingClickHandlers();
    return;
  }

  // Single batch request for all missing ratings
  pendingRatingsRequest = fetch('/api/get-ratings-batch/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseIds: needsFetch })
  })
  .then(function(response) { return response.ok ? response.json() : null; })
  .then(function(data) {
    pendingRatingsRequest = null;
    if (data && data.success && data.ratings) {
      FWCache.update('ratings', function(current) {
        return Object.assign({}, current, data.ratings);
      });
      return data.ratings;
    }
    return {};
  })
  .catch(function(error) {
    pendingRatingsRequest = null;
    return {};
  });

  pendingRatingsRequest.then(function(ratings) {
    releaseCards.forEach(function(card) {
      var id = card.getAttribute('data-release');
      if (ratings && ratings[id]) {
        updateSingleRatingUI(card, id, ratings[id]);
      }
    });
  });

  setupRatingClickHandlers();
}

function updateSingleRatingUI(card, releaseId, ratingData) {
  var average = ratingData.average || 0;
  var count = ratingData.count || 0;

  var ratingValue = card.querySelector('.rating-value[data-release-id="' + releaseId + '"]');
  var ratingCount = card.querySelector('.rating-count[data-release-id="' + releaseId + '"]');

  if (ratingValue) ratingValue.textContent = average.toFixed(1);
  if (ratingCount) ratingCount.textContent = ' (' + count + ')';

  // Stars stay empty - only fill when user rates (handled in click handler)
}

function setupRatingClickHandlers() {
  document.querySelectorAll('.rating-star').forEach(function(star) {
    if (star.hasAttribute('data-rating-click-init')) return;
    star.setAttribute('data-rating-click-init', 'true');

    star.onclick = async function() {
      var releaseId = star.getAttribute('data-release-id');
      var rating = parseInt(star.getAttribute('data-star'));

      // Extended debounce - 2 seconds
      if (ratingDebounce[releaseId]) return;
      ratingDebounce[releaseId] = true;
      setTimeout(function() { delete ratingDebounce[releaseId]; }, 2000);

      // Wait for auth to be ready
      var user = await getAuthUser();
      if (!user) {
        alert('Please log in to rate releases.');
        var currentPage = window.location.pathname;
        window.location.href = '/login/?redirect=' + encodeURIComponent(currentPage);
        return;
      }

      // Get ID token for API authentication
      var idToken = null;
      try {
        if (window.firebaseAuth && window.firebaseAuth.currentUser) {
          idToken = await window.firebaseAuth.currentUser.getIdToken();
        }
      } catch (e){ /* Ignore token errors, API will use userId fallback */ }

      var card = document.querySelector('[data-release="' + releaseId + '"]');

      // Optimistic UI update
      if (card) {
        card.querySelectorAll('.rating-star[data-release-id="' + releaseId + '"]').forEach(function(s) {
          var starNum = parseInt(s.getAttribute('data-star'));
          var svg = s.querySelector('svg');
          if (svg) {
            svg.setAttribute('fill', starNum <= rating ? 'currentColor' : 'none');
          }
        });
      }

      var headers = { 'Content-Type': 'application/json' };
      if (idToken) {
        headers['Authorization'] = 'Bearer ' + idToken;
      }

      fetch('/api/rate-release/', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ releaseId: releaseId, rating: rating, userId: user.uid })
      })
      .then(function(response) { return response.ok ? response.json() : null; })
      .then(function(data) {
        if (data && data.success) {
          FWCache.update('ratings', function(current) {
            current[releaseId] = { average: data.newRating, count: data.ratingsCount };
            return current;
          });

          if (card) {
            var ratingValue = card.querySelector('.rating-value[data-release-id="' + releaseId + '"]');
            var ratingCount = card.querySelector('.rating-count[data-release-id="' + releaseId + '"]');
            if (ratingValue) ratingValue.textContent = data.newRating.toFixed(1);
            if (ratingCount) ratingCount.textContent = ' (' + data.ratingsCount + ')';
          }
        }
      })
      .catch(function(error) { console.error('[ReleasePlate] Rating submission error:', error); });
    };
  });
}

// Fetch and display user's own ratings when logged in
var userRatingsFetched = false;
async function fetchUserRatings() {
  if (userRatingsFetched) return;

  // Wait for auth to be ready
  var user = await getAuthUser();
  if (!user) return;

  userRatingsFetched = true;

  // Get all release IDs on the page
  var releaseCards = document.querySelectorAll('[data-release]');
  var releaseIds = [];
  releaseCards.forEach(function(card) {
    var id = card.getAttribute('data-release');
    if (id) releaseIds.push(id);
  });

  if (releaseIds.length === 0) return;

  // Get ID token for API authentication
  var idToken = null;
  try {
    if (window.firebaseAuth && window.firebaseAuth.currentUser) {
      idToken = await window.firebaseAuth.currentUser.getIdToken();
    }
  } catch (e){ /* Ignore */ }

  if (!idToken) return;

  try {
    var response = await fetch('/api/get-user-ratings/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      },
      body: JSON.stringify({ releaseIds: releaseIds })
    });

    if (!response.ok) return;
    var data = await response.json();

    if (data.success && data.userRatings) {
      // Fill in stars for releases the user has rated
      Object.keys(data.userRatings).forEach(function(releaseId) {
        var userRating = data.userRatings[releaseId];
        var card = document.querySelector('[data-release="' + releaseId + '"]');
        if (card) {
          card.querySelectorAll('.rating-star[data-release-id="' + releaseId + '"]').forEach(function(star) {
            var starNum = parseInt(star.getAttribute('data-star'));
            var svg = star.querySelector('svg');
            if (svg) {
              svg.setAttribute('fill', starNum <= userRating ? 'currentColor' : 'none');
            }
          });
        }
      });
    }
  } catch (e){
    console.error('[Ratings] Failed to fetch user ratings:', e);
  }
}

// ============================================
// SHARE SYSTEM
// ============================================
var shareInitialized = false;

function initShareSystem() {
  if (shareInitialized) return;
  shareInitialized = true;

  var shareModal = document.getElementById('share-modal');
  var shareModalClose = document.getElementById('share-modal-close');
  var shareModalBackdrop = document.getElementById('share-modal-backdrop');
  var shareUrlInput = document.getElementById('share-url-input');
  var copyUrlButton = document.getElementById('copy-url-button');
  var copyFeedback = document.getElementById('copy-feedback');
  var copyBtnText = document.getElementById('copy-btn-text');
  var shareModalTitle = document.getElementById('share-modal-title');
  var shareModalArtist = document.getElementById('share-modal-artist');
  var shareModalArtwork = document.getElementById('share-modal-artwork');

  if (!shareModal) return;

  var previousFocus = null;

  // Store current share data for social buttons
  window.currentReleaseShareData = {};

  document.querySelectorAll('.share-button').forEach(function(button) {
    button.onclick = function() {
      var releaseId = button.getAttribute('data-release-id');
      var title = button.getAttribute('data-title');
      var artist = button.getAttribute('data-artist');
      var artwork = button.getAttribute('data-artwork') || '/place-holder.webp';
      var url = window.location.origin + '/item/' + releaseId;

      window.currentReleaseShareData = { title: title, artist: artist, url: url, artwork: artwork };

      if (shareModalTitle) shareModalTitle.textContent = title;
      if (shareModalArtist) shareModalArtist.textContent = artist;
      if (shareModalArtwork) shareModalArtwork.src = artwork;
      if (shareUrlInput) shareUrlInput.value = url;
      if (copyFeedback) copyFeedback.classList.add('hidden');

      // Show native share button on supported devices
      var nativeShareBtn = document.getElementById('native-share-btn');
      if (navigator.share && nativeShareBtn) {
        nativeShareBtn.classList.remove('hidden');
        nativeShareBtn.classList.add('flex');
      }

      previousFocus = document.activeElement;
      shareModal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      if (shareModalClose) shareModalClose.focus();
    };
  });

  function closeModal() {
    shareModal.classList.add('hidden');
    document.body.style.overflow = '';
    if (previousFocus && typeof previousFocus.focus === 'function') {
      previousFocus.focus();
      previousFocus = null;
    }
  }

  // Focus trap: Tab/Shift+Tab cycles within the modal
  shareModal.addEventListener('keydown', function(e) {
    if (e.key !== 'Tab') return;
    var focusableEls = shareModal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusableEls.length === 0) return;
    var firstEl = focusableEls[0];
    var lastEl = focusableEls[focusableEls.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  });

  if (shareModalClose) shareModalClose.onclick = closeModal;
  if (shareModalBackdrop) shareModalBackdrop.onclick = closeModal;

  if (copyUrlButton) {
    copyUrlButton.onclick = function() {
      navigator.clipboard.writeText(shareUrlInput.value)
        .then(function() {
          if (copyBtnText) copyBtnText.textContent = 'Copied!';
          if (copyFeedback) copyFeedback.classList.remove('hidden');
          setTimeout(function() {
            if (copyBtnText) copyBtnText.textContent = 'Copy';
            if (copyFeedback) copyFeedback.classList.add('hidden');
          }, 2000);
        })
        .catch(function() {
          if (copyFeedback) {
            copyFeedback.textContent = 'Failed to copy';
            copyFeedback.classList.remove('hidden');
          }
        });
    };
  }

  // Social share buttons
  document.getElementById('share-twitter')?.addEventListener('click', function() {
    var d = window.currentReleaseShareData || {};
    var text = 'Check out "' + d.title + '" by ' + d.artist + ' on Fresh Wax';
    window.open('https://x.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(d.url), '_blank', 'noopener,noreferrer,width=550,height=420');
  });

  document.getElementById('share-facebook')?.addEventListener('click', function() {
    var d = window.currentReleaseShareData || {};
    window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(d.url), '_blank', 'noopener,noreferrer,width=550,height=420');
  });

  document.getElementById('share-whatsapp')?.addEventListener('click', function() {
    var d = window.currentReleaseShareData || {};
    var text = 'Check out "' + d.title + '" by ' + d.artist + ' on Fresh Wax ' + d.url;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
  });

  document.getElementById('share-instagram')?.addEventListener('click', function() {
    var d = window.currentReleaseShareData || {};
    var text = d.url;
    navigator.clipboard.writeText(text).then(function() {
      alert('Link copied! Paste it in your Instagram story or bio.');
    });
  });

  document.getElementById('share-reddit')?.addEventListener('click', function() {
    var d = window.currentReleaseShareData || {};
    var title = d.title + ' by ' + d.artist + ' - Fresh Wax';
    window.open('https://www.reddit.com/submit?url=' + encodeURIComponent(d.url) + '&title=' + encodeURIComponent(title), '_blank', 'noopener,noreferrer,width=550,height=420');
  });

  // Native share (mobile)
  document.getElementById('native-share-btn')?.addEventListener('click', async function() {
    var d = window.currentReleaseShareData || {};
    try {
      await navigator.share({
        title: d.title + ' by ' + d.artist,
        text: 'Check out this release on Fresh Wax',
        url: d.url
      });
    } catch (err) {
      // Share cancelled or failed
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !shareModal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

// Toast notification — uses global showToast from Layout.astro

// ============================================
// RELEASE PLAYER - TRACKLIST PREVIEWS
// Lazy audio creation, AudioManager integration
// CLIP RESTRICTION: Play 90 seconds (1:30) starting at 60s into the track
// ============================================
var CLIP_START_TIME = 60; // Start at 60 seconds into track
var CLIP_DURATION = 90;   // Play for 90 seconds (1:30) max
var CLIP_END_TIME = CLIP_START_TIME + CLIP_DURATION; // Stop at 150 seconds
var FADE_DURATION = 3;    // Fade in/out over 3 seconds
var FADE_OUT_START = CLIP_END_TIME - FADE_DURATION; // Start fading out 3s before end

function initReleasePlayer() {
  document.querySelectorAll('[data-release]').forEach(function(releaseCard) {
    if (releaseCard.hasAttribute('data-player-init')) return;
    releaseCard.setAttribute('data-player-init', 'true');

    var releaseId = releaseCard.getAttribute('data-release');
    if (!releaseId) return;

    var canvas = releaseCard.querySelector('.shared-waveform[data-release-id="' + releaseId + '"]');
    var volumeSlider = releaseCard.querySelector('.shared-volume-slider[data-release-id="' + releaseId + '"]');
    var nowPlayingText = releaseCard.querySelector('[data-now-playing-text="' + releaseId + '"]');
    var playButtons = releaseCard.querySelectorAll('.play-button');

    var currentAudio = null;
    var currentButton = null;
    var currentVolume = 0.7;
    var ctx = null;
    var bars = 60;
    var barWidth = 0;

    if (canvas) {
      ctx = canvas.getContext('2d');
      var container = canvas.parentElement;
      var containerWidth = container.offsetWidth;
      canvas.width = Math.min(containerWidth, 400);
      canvas.height = 50;
      barWidth = (canvas.width / bars) - 1;
      drawWaveform(0, false);

      canvas.onclick = function(e) {
        if (!currentAudio || !currentAudio.duration || !isFinite(currentAudio.duration)) return;
        var rect = canvas.getBoundingClientRect();
        var progress = (e.clientX - rect.left) / rect.width;
        // Seek within clip window (60s-150s) - waveform represents only the clip
        var seekTime = CLIP_START_TIME + (progress * CLIP_DURATION);
        currentAudio.currentTime = Math.min(Math.max(seekTime, CLIP_START_TIME), CLIP_END_TIME - 1);
      };
    }

    function drawWaveform(progress, isPlaying) {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < bars; i++) {
        var height = (Math.random() * 0.5 + 0.3) * canvas.height;
        var x = i * (barWidth + 1);
        var y = (canvas.height - height) / 2;
        // Played = red, Unplayed = white when playing, gray when stopped
        ctx.fillStyle = isPlaying ? (i / bars < progress ? '#dc2626' : '#ffffff') : (i / bars < progress ? '#dc2626' : '#4b5563');
        ctx.fillRect(x, y, barWidth, height);
      }
    }

    if (volumeSlider) {
      volumeSlider.oninput = function() {
        currentVolume = volumeSlider.value / 100;
        if (currentAudio) currentAudio.volume = currentVolume;
      };
    }

    playButtons.forEach(function(button) {
      var trackId = button.getAttribute('data-track-id');
      var previewUrl = button.getAttribute('data-preview-url');
      var trackTitle = button.getAttribute('data-track-title') || 'Unknown Track';
      var playIcon = button.querySelector('.play-icon');
      var pauseIcon = button.querySelector('.pause-icon');

      button.onclick = function() {
        if (!previewUrl) {
          alert('Preview not available for this track');
          if (nowPlayingText) nowPlayingText.textContent = 'Preview not available';
          return;
        }

        var audio = releaseCard.querySelector('.track-audio[data-track-id="' + trackId + '"]');

        if (!audio) {
          audio = document.createElement('audio');
          audio.className = 'hidden track-audio';
          audio.setAttribute('data-track-id', trackId);
          audio.setAttribute('data-release-id', releaseId);
          audio.preload = 'none';
          audio.src = previewUrl;
          audio.volume = currentVolume;
          releaseCard.appendChild(audio);

          audio.ontimeupdate = function() {
            if (audio === currentAudio && audio.duration && isFinite(audio.duration)) {
              var currentTime = audio.currentTime;

              // CLIP RESTRICTION: Stop playback at CLIP_END_TIME (150s)
              if (currentTime >= CLIP_END_TIME) {
                audio.pause();
                audio.volume = currentVolume; // Reset volume after fade
                audio.currentTime = CLIP_START_TIME;
                button.classList.remove('playing');
                if (playIcon) playIcon.classList.remove('hidden');
                if (pauseIcon) pauseIcon.classList.add('hidden');
                if (nowPlayingText) nowPlayingText.textContent = '90s preview ended';
                drawWaveform(0, false);
                showToast('90 second preview ended');
                if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
                return;
              }

              // FADE IN: First 3 seconds of clip (60s to 63s)
              if (currentTime >= CLIP_START_TIME && currentTime < CLIP_START_TIME + FADE_DURATION) {
                var fadeInProgress = (currentTime - CLIP_START_TIME) / FADE_DURATION;
                audio.volume = currentVolume * fadeInProgress;
              }
              // FADE OUT: Last 3 seconds of clip (147s to 150s)
              else if (currentTime >= FADE_OUT_START) {
                var fadeOutProgress = (CLIP_END_TIME - currentTime) / FADE_DURATION;
                audio.volume = currentVolume * Math.max(0, fadeOutProgress);
              }
              // Normal volume in between
              else {
                audio.volume = currentVolume;
              }

              // Show clip progress on waveform (60s-150s = 0%-100%)
              var clipProgress = (currentTime - CLIP_START_TIME) / CLIP_DURATION;
              drawWaveform(Math.max(0, Math.min(1, clipProgress)), !audio.paused);
            }
          };

          audio.onloadedmetadata = function() {
            // Set starting position to 60 seconds (or 0 if track is shorter)
            if (audio.duration > CLIP_START_TIME) {
              audio.currentTime = CLIP_START_TIME;
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
          if (a !== audio && !a.paused) {
            a.pause();
            a.currentTime = 0;
          }
        });

        document.querySelectorAll('[data-release]').forEach(function(otherCard) {
          if (otherCard !== releaseCard) {
            otherCard.querySelectorAll('.track-audio').forEach(function(a) {
              if (!a.paused) {
                a.pause();
                a.currentTime = 0;
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

        // Ensure we start at the clip start position (60s)
        if (audio.duration && audio.duration > CLIP_START_TIME) {
          if (audio.currentTime < CLIP_START_TIME || audio.currentTime >= CLIP_END_TIME) {
            audio.currentTime = CLIP_START_TIME;
            audio.volume = 0; // Start at 0 for fade in
          }
        } else {
          audio.volume = 0; // Start at 0 for fade in
        }

        audio.play().then(function() {
          button.classList.add('playing');
          if (playIcon) playIcon.classList.add('hidden');
          if (pauseIcon) pauseIcon.classList.remove('hidden');
          if (nowPlayingText) nowPlayingText.textContent = trackTitle;
          showToast('Playing 90 second preview');
        }).catch(function(err) {
          audio.volume = currentVolume; // Reset volume on error
          alert('Could not play preview. The file may be unavailable.');
          if (window.AudioManager) window.AudioManager.onTracklistPreviewStop(audio);
        });
      };
    });
  });
}

// ============================================
// CART FUNCTIONALITY - EVENT DELEGATION
// Uses customer-specific cart (freshwax_cart_${customerId})
// ============================================

// Cart helper functions — uses global FreshWaxCart from freshwax-cart.js

if (!window.cartListenersAttached) {
  window.cartListenersAttached = true;

  // Add to cart (digital/vinyl releases)
  document.addEventListener('click', async function(e) {
    var button = e.target.closest('.add-to-cart');
    if (!button || button.hasAttribute('disabled')) return;

    e.preventDefault();

    // Check for customer login
    if (!window.FreshWaxCart || !FreshWaxCart.isLoggedIn()) {
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }

    var releaseId = button.getAttribute('data-release-id');
    var productType = button.getAttribute('data-product-type');
    var price = parseFloat(button.getAttribute('data-price') || '0');
    var title = button.getAttribute('data-title');
    var artist = button.getAttribute('data-artist');
    var labelName = button.getAttribute('data-label-name');
    var artwork = button.getAttribute('data-artwork');

    // Check if user already owns this release
    try {
      var userId = null;
      if (window.firebaseAuth && window.firebaseAuth.currentUser) {
        userId = window.firebaseAuth.currentUser.uid;
      }

      if (userId) {
        // Check cache first
        var ownershipCache = FWCache.get('ownership_' + userId) || {};
        var cachedOwnership = ownershipCache[releaseId];

        if (!cachedOwnership) {
          var _token = window.firebaseAuth?.currentUser ? await window.firebaseAuth.currentUser.getIdToken() : null;
          var _headers = _token ? { 'Authorization': 'Bearer ' + _token } : {};
          var checkRes = await fetch('/api/check-ownership/?userId=' + userId + '&releaseId=' + releaseId, { headers: _headers });
          if (!checkRes.ok) { cachedOwnership = {}; } else { cachedOwnership = await checkRes.json(); }
          // Cache the result
          ownershipCache[releaseId] = cachedOwnership;
          FWCache.set('ownership_' + userId, ownershipCache, FWCache.TTL.OWNERSHIP);
        }

        if (cachedOwnership.ownsFullRelease) {
          showToast('You already own this release! Check your order history for download links.');
          return;
        }
      }
    } catch (err) {
    }

    var cart = FreshWaxCart.get();
    var items = cart.items || [];

    // If adding vinyl, remove digital version (vinyl includes digital)
    if (productType === 'vinyl') {
      items = items.filter(function(item) {
        return !(item.id === releaseId && item.type === 'digital');
      });
    }

    // If adding full release (digital or vinyl), remove any single tracks from this release
    if (productType === 'digital' || productType === 'vinyl') {
      var removedTracks = items.filter(function(item) {
        return item.id === releaseId && item.type === 'track';
      });

      if (removedTracks.length > 0) {
        items = items.filter(function(item) {
          return !(item.id === releaseId && item.type === 'track');
        });
      }
    }

    // Check if already in cart
    var existingIndex = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === releaseId && items[i].type === productType) {
        existingIndex = i;
        break;
      }
    }

    if (existingIndex !== -1) {
      items[existingIndex].quantity = (items[existingIndex].quantity || 1) + 1;
    } else {
      items.push({
        id: releaseId,
        releaseId: releaseId,
        type: productType,
        format: productType,
        name: artist + ' - ' + title,
        title: title,
        artist: artist,
        labelName: labelName,
        price: price,
        image: artwork,
        artwork: artwork,
        quantity: 1
      });
    }

    FreshWaxCart.save({items: items});
    FreshWaxCart.updateBadge();

    var originalHTML = button.innerHTML;
    button.innerHTML = '<span>✓ Added!</span>';
    button.classList.add('bg-green-700');

    setTimeout(function() {
      button.innerHTML = originalHTML;
      button.classList.remove('bg-green-700');
    }, 1500);
  });

  // Buy individual track
  document.addEventListener('click', async function(e) {
    var button = e.target.closest('.buy-track');
    if (!button) return;

    e.preventDefault();

    // Check for customer login
    if (!window.FreshWaxCart || !FreshWaxCart.isLoggedIn()) {
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }

    var trackId = button.getAttribute('data-track-id');
    var trackTitle = button.getAttribute('data-track-title');
    var trackPrice = parseFloat(button.getAttribute('data-track-price') || '0');
    var releaseId = button.getAttribute('data-release-id');
    var artist = button.getAttribute('data-artist');
    var artwork = button.getAttribute('data-artwork');

    var cart = FreshWaxCart.get();
    var items = cart.items || [];

    // Check if full release already in cart
    var hasFullRelease = items.some(function(item) {
      return item.id === releaseId && (item.type === 'digital' || item.type === 'vinyl');
    });

    if (hasFullRelease) {
      showToast('You already have the full release in your cart! No need to buy individual tracks.');
      return;
    }

    // Check if track already in cart
    var hasTrack = items.some(function(item) {
      return item.id === releaseId && item.trackId === trackId;
    });

    if (hasTrack) {
      showToast('This track is already in your cart!');
      return;
    }

    // Check if user already owns this release or track
    try {
      var userId = null;
      if (window.firebaseAuth && window.firebaseAuth.currentUser) {
        userId = window.firebaseAuth.currentUser.uid;
      }

      if (userId) {
        // Check cache first
        var ownershipCache = FWCache.get('ownership_' + userId) || {};
        var cachedOwnership = ownershipCache[releaseId];

        if (!cachedOwnership) {
          var _token2 = window.firebaseAuth?.currentUser ? await window.firebaseAuth.currentUser.getIdToken() : null;
          var _headers2 = _token2 ? { 'Authorization': 'Bearer ' + _token2 } : {};
          var checkRes = await fetch('/api/check-ownership/?userId=' + userId + '&releaseId=' + releaseId + '&trackId=' + trackId, { headers: _headers2 });
          if (!checkRes.ok) { cachedOwnership = {}; } else { cachedOwnership = await checkRes.json(); }
          // Cache the result
          ownershipCache[releaseId] = cachedOwnership;
          FWCache.set('ownership_' + userId, ownershipCache, FWCache.TTL.OWNERSHIP);
        }

        if (cachedOwnership.ownsFullRelease) {
          alert('You already own the full release that includes this track! Check your order history for download links.');
          return;
        }

        // Check if track is owned (from cached ownedTrackIds or direct check)
        var ownsThisTrack = cachedOwnership.ownedTrackIds && cachedOwnership.ownedTrackIds.indexOf(trackId) !== -1;
        if (ownsThisTrack) {
          alert('You already own this track! Check your order history for download links.');
          return;
        }
      }
    } catch (err) {
    }

    items.push({
      id: releaseId,
      releaseId: releaseId,
      trackId: trackId,
      type: 'track',
      format: 'track',
      name: artist + ' - ' + trackTitle,
      title: trackTitle,
      artist: artist,
      price: trackPrice,
      image: artwork,
      artwork: artwork,
      quantity: 1
    });

    FreshWaxCart.save({items: items});
    FreshWaxCart.updateBadge();

    var originalHTML = button.innerHTML;
    button.innerHTML = '✓';
    button.classList.add('bg-green-700');

    setTimeout(function() {
      button.innerHTML = originalHTML;
      button.classList.remove('bg-green-700');
    }, 1500);
  });
}

// ============================================
// WISHLIST SYSTEM
// ============================================
function initWishlistSystem() {
  // Prevent duplicate initialization
  if (window._wishlistInitialized) {
    return;
  }
  window._wishlistInitialized = true;

  // Helper to get userId from cookie
  function getUserId() {
    var match = document.cookie.match(/(?:^|; )userId=([^;]*)/);
    return match ? match[1] : null;
  }

  var wishlistButtons = document.querySelectorAll('.wishlist-btn');

  // Function to fetch and update wishlist state
  async function fetchWishlistState() {
    var user = window.firebaseAuth?.currentUser;
    if (user && wishlistButtons.length > 0) {
      try {
        var token = await user.getIdToken();
        fetch('/api/wishlist/?userId=' + user.uid, {
          headers: { 'Authorization': 'Bearer ' + token }
        })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
            if (data && data.success && data.wishlist) {
              var wishlistIds = data.wishlist.map(function(r) { return r.id; });
              wishlistButtons.forEach(function(btn) {
                var releaseId = btn.getAttribute('data-release-id');
                if (wishlistIds.includes(releaseId)) {
                  setWishlistState(btn, true);
                }
              });
            }
          })
          .catch(function(err) {
            console.error('Failed to load wishlist state:', err);
          });
      } catch (err) {
        console.error('Failed to get auth token for wishlist:', err);
      }
    }
  }

  // Wait for auth to be ready before checking wishlist state
  if (window.authReady) {
    window.authReady.then(function(user) {
      if (user) {
        fetchWishlistState();
      }
    });
  } else if (window.firebaseAuth) {
    window.firebaseAuth.onAuthStateChanged(function(user) {
      if (user) {
        fetchWishlistState();
      }
    });
  }

  // Use event delegation - one listener on document
  document.addEventListener('click', async function(e) {
    var btn = e.target.closest('.wishlist-btn');
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    var user = window.firebaseAuth?.currentUser;
    var releaseId = btn.getAttribute('data-release-id');

    // Must be logged in to use wishlist
    if (!user) {
      showToast('Please log in to add items to your wishlist');
      return;
    }

    // Disable button during request
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';

    try {
      var token = await user.getIdToken();

      // Call API to toggle wishlist
      fetch('/api/wishlist/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          userId: user.uid,
          releaseId: releaseId,
          action: 'toggle'
        })
      })
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';

        if (data && data.success) {
          setWishlistState(btn, data.inWishlist);
          showToast(data.inWishlist ? 'Added to wishlist!' : 'Removed from wishlist');
        } else {
          showToast('Failed to update wishlist');
        }
      })
      .catch(function(err) {
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        console.error('Wishlist error:', err);
        showToast('Failed to update wishlist');
      });
    } catch (err) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      console.error('Auth error:', err);
      showToast('Authentication error');
    }
  });
}

function setWishlistState(btn, inWishlist) {
  var emptyIcon = btn.querySelector('.wishlist-icon-empty');
  var filledIcon = btn.querySelector('.wishlist-icon-filled');
  var textSpan = btn.querySelector('.wishlist-text');

  if (inWishlist) {
    if (emptyIcon) emptyIcon.classList.add('hidden');
    if (filledIcon) filledIcon.classList.remove('hidden');
    if (textSpan) textSpan.textContent = 'Wishlisted';
    btn.setAttribute('title', 'Remove from wishlist');
  } else {
    if (emptyIcon) emptyIcon.classList.remove('hidden');
    if (filledIcon) filledIcon.classList.add('hidden');
    if (textSpan) textSpan.textContent = 'Wishlist';
    btn.setAttribute('title', 'Add to wishlist');
  }
}

// ============================================
// PRE-ORDER SYSTEM
// ============================================
function initPreorderSystem() {
  var preorderButtons = document.querySelectorAll('.preorder-btn');

  preorderButtons.forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.preventDefault();

      // Check for customer login
      if (!window.FreshWaxCart || !FreshWaxCart.isLoggedIn()) {
        window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }

      var releaseId = btn.getAttribute('data-release-id');
      var title = btn.getAttribute('data-title');
      var artist = btn.getAttribute('data-artist');
      var artwork = btn.getAttribute('data-artwork');
      var price = parseFloat(btn.getAttribute('data-price') || '0');
      var releaseDate = btn.getAttribute('data-release-date');

      var cart = FreshWaxCart.get();
      var items = cart.items || [];

      // Check if already in cart
      var existingIndex = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === releaseId && (items[i].type === 'digital' || items[i].type === 'preorder')) {
          existingIndex = i;
          break;
        }
      }

      if (existingIndex !== -1) {
        // Already in cart
        var originalHTML = btn.innerHTML;
        btn.innerHTML = '<span class="flex items-center gap-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> In Cart</span>';
        setTimeout(function() {
          btn.innerHTML = originalHTML;
        }, 1500);
        return;
      }

      // Add to cart as pre-order
      items.push({
        id: releaseId,
        releaseId: releaseId,
        type: 'digital',
        format: 'digital',
        name: artist + ' - ' + title,
        title: title,
        artist: artist,
        price: price,
        image: artwork,
        artwork: artwork,
        quantity: 1,
        isPreOrder: true,
        releaseDate: releaseDate
      });

      FreshWaxCart.save({items: items});
    FreshWaxCart.updateBadge();

      // Show success state
      var originalHTML = btn.innerHTML;
      btn.innerHTML = '<span class="flex items-center gap-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Added!</span>';
      btn.classList.remove('from-orange-500', 'to-red-500');
      btn.classList.add('from-green-500', 'to-green-600');

      setTimeout(function() {
        btn.innerHTML = originalHTML;
        btn.classList.remove('from-green-500', 'to-green-600');
        btn.classList.add('from-orange-500', 'to-red-500');
      }, 1500);
    });
  });
}

// ============================================
// INITIALIZE ALL SYSTEMS
// ============================================
function initAll() {
  FWCache.cleanup();
  initReleasePlayer();
  initRatingSystem();
  initShareSystem();
  initWishlistSystem();
  initPreorderSystem();
  initNYOPSystem();
  // Fetch user's own ratings (async, runs after auth is ready)
  fetchUserRatings();
}

// NYOP (Name Your Own Price) Modal System
var nyopModalInitialized = false;
var nyopCurrentReleaseData = null;

function initNYOPSystem() {
  var modal = document.getElementById('nyop-modal');
  if (!modal) return;

  var modalArtwork = document.getElementById('nyop-modal-artwork');
  var modalTitle = document.getElementById('nyop-modal-title');
  var modalArtist = document.getElementById('nyop-modal-artist');
  var modalPrice = document.getElementById('nyop-modal-price');
  var modalMinText = document.getElementById('nyop-modal-min-text');
  var modalError = document.getElementById('nyop-modal-error');
  var modalAddCart = document.getElementById('nyop-modal-add-cart');
  var quickPrices = modal.querySelectorAll('.nyop-quick-price');

  // Attach open modal listeners to buttons (with guard)
  document.querySelectorAll('.nyop-open-modal').forEach(function(btn) {
    if (btn.dataset.nyopInit === 'true') return;
    btn.dataset.nyopInit = 'true';

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      var minPrice = parseFloat(btn.dataset.nyopMin) || 0;
      var suggestedPrice = parseFloat(btn.dataset.nyopSuggested) || minPrice || 5;

      nyopCurrentReleaseData = {
        releaseId: btn.dataset.releaseId,
        title: btn.dataset.title,
        artist: btn.dataset.artist,
        labelName: btn.dataset.labelName,
        artwork: btn.dataset.artwork,
        minPrice: minPrice,
        suggestedPrice: suggestedPrice,
        isPreorder: btn.dataset.isPreorder === 'true'
      };

      // Populate modal
      modalArtwork.src = nyopCurrentReleaseData.artwork || '/place-holder.webp';
      modalTitle.textContent = nyopCurrentReleaseData.title;
      modalArtist.textContent = nyopCurrentReleaseData.artist;
      modalPrice.value = suggestedPrice.toFixed(2);
      modalMinText.textContent = minPrice > 0
        ? '£' + minPrice.toFixed(2) + ' minimum'
        : 'Pay what you want (including £0)';
      modalError.classList.add('hidden');

      // Update quick price buttons
      updateQuickPriceButtons(suggestedPrice);

      // Show modal
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    });
  });

  // Skip rest if already initialized
  if (nyopModalInitialized) return;
  nyopModalInitialized = true;

  function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    nyopCurrentReleaseData = null;
  }

  // Close modal
  modal.querySelectorAll('[data-close-modal]').forEach(function(el) {
    el.addEventListener('click', closeModal);
  });

  // Close on escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  // Quick price buttons
  quickPrices.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var price = parseFloat(btn.dataset.price) || 0;
      modalPrice.value = price.toFixed(2);
      updateQuickPriceButtons(price);
      validatePrice();
    });
  });

  function updateQuickPriceButtons(selectedPrice) {
    quickPrices.forEach(function(btn) {
      var btnPrice = parseFloat(btn.dataset.price) || 0;
      if (btnPrice === selectedPrice) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // Price input handling
  modalPrice.addEventListener('input', function() {
    validatePrice();
    // Remove active state from quick buttons when typing
    quickPrices.forEach(function(b) { b.classList.remove('active'); });
  });

  modalPrice.addEventListener('blur', function() {
    var value = parseFloat(modalPrice.value) || 0;
    var minPrice = nyopCurrentReleaseData ? nyopCurrentReleaseData.minPrice : 0;
    modalPrice.value = Math.max(minPrice, value).toFixed(2);
    validatePrice();
  });

  function validatePrice() {
    if (!nyopCurrentReleaseData) return true;

    var value = parseFloat(modalPrice.value) || 0;
    var minPrice = nyopCurrentReleaseData.minPrice || 0;

    if (value < minPrice) {
      modalError.textContent = 'Minimum price is £' + minPrice.toFixed(2);
      modalError.classList.remove('hidden');
      modalAddCart.disabled = true;
      modalAddCart.classList.add('opacity-50', 'cursor-not-allowed');
      return false;
    } else {
      modalError.classList.add('hidden');
      modalAddCart.disabled = false;
      modalAddCart.classList.remove('opacity-50', 'cursor-not-allowed');
      return true;
    }
  }

  // Add to cart
  modalAddCart.addEventListener('click', function() {
    if (!nyopCurrentReleaseData || !validatePrice()) return;

    var price = parseFloat(modalPrice.value) || 0;

    // Trigger the existing cart system via temporary button
    var tempBtn = document.createElement('button');
    tempBtn.className = 'add-to-cart hidden';
    tempBtn.dataset.releaseId = nyopCurrentReleaseData.releaseId;
    tempBtn.dataset.productType = 'digital';
    tempBtn.dataset.price = price.toFixed(2);
    tempBtn.dataset.title = nyopCurrentReleaseData.title;
    tempBtn.dataset.artist = nyopCurrentReleaseData.artist;
    tempBtn.dataset.labelName = nyopCurrentReleaseData.labelName || '';
    tempBtn.dataset.artwork = nyopCurrentReleaseData.artwork;
    tempBtn.dataset.isPreorder = nyopCurrentReleaseData.isPreorder ? 'true' : 'false';
    document.body.appendChild(tempBtn);
    tempBtn.click();
    setTimeout(function() { tempBtn.remove(); }, 100);

    // Close modal
    closeModal();
  });
}

export function init() {
  // Reset initialization flags for page transitions
  shareInitialized = false;
  initAll();
}
