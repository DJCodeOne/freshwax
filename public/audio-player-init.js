// ===========================================
// GLOBAL AUDIO PLAYER WITH SHUFFLE & SPECTRUM
// ===========================================

(function() {
  // Prevent duplicate initialization
  if (window.FreshWaxPlayer && window.FreshWaxPlayer._initialized) {
    return;
  }

  window.FreshWaxPlayer = {
    _initialized: true,
    currentMix: null,
    hasTrackedPlay: false,

    // Shuffle state
    shuffleTracks: null,
    shuffledQueue: [],
    shuffleIndex: 0,
    isShuffleMode: false
  };

  // Timer IDs for cleanup on View Transitions
  var _errorRetryTimer = 0;
  var _stallRecoveryTimer = 0;
  var _shuffleRetryTimer = 0;

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  }

  // === SPECTRUM ANALYSER (Simulated - works without CORS) ===
  var spectrumAnimationId = null;
  var spectrumBars = { left: [], right: [] };
  var barValues = [0, 0, 0, 0, 0, 0, 0, 0];
  var targetValues = [0, 0, 0, 0, 0, 0, 0, 0];

  function initSpectrumBars() {
    spectrumBars.left = document.querySelectorAll('#spectrum-left .spectrum-bar');
    spectrumBars.right = document.querySelectorAll('#spectrum-right .spectrum-bar');
  }

  function updateSpectrum() {
    var audio = document.getElementById('global-audio');
    var isPlaying = audio && !audio.paused && !audio.ended && audio.readyState > 2;

    if (isPlaying) {
      for (var i = 0; i < 8; i++) {
        var baseBias = 1 - (i * 0.08);
        var randomness = Math.random();
        targetValues[i] = Math.min(32, Math.max(4,
          (randomness * 28 * baseBias) + 4 + (Math.sin(Date.now() / (200 + i * 50)) * 8)
        ));
      }
    } else {
      for (var i = 0; i < 8; i++) {
        targetValues[i] = 4;
      }
    }

    for (var i = 0; i < 8; i++) {
      barValues[i] += (targetValues[i] - barValues[i]) * 0.3;
      var height = Math.round(barValues[i]);

      if (spectrumBars.left[i]) {
        spectrumBars.left[i].style.height = height + 'px';
        if (height > 12) spectrumBars.left[i].classList.add('active');
        else spectrumBars.left[i].classList.remove('active');
      }
      if (spectrumBars.right[i]) {
        spectrumBars.right[i].style.height = height + 'px';
        if (height > 12) spectrumBars.right[i].classList.add('active');
        else spectrumBars.right[i].classList.remove('active');
      }
    }

    spectrumAnimationId = requestAnimationFrame(updateSpectrum);
  }

  function startSpectrum() {
    var miniPlayer = document.getElementById('mini-player');
    if (miniPlayer) miniPlayer.classList.add('playing');
    initSpectrumBars();
    if (!spectrumAnimationId) {
      updateSpectrum();
    }
  }

  function stopSpectrum() {
    if (spectrumAnimationId) {
      cancelAnimationFrame(spectrumAnimationId);
      spectrumAnimationId = null;
    }
    var miniPlayer = document.getElementById('mini-player');
    if (miniPlayer) miniPlayer.classList.remove('playing');
  }

  function initMiniPlayer() {
    // Prevent multiple initializations (use window property to persist across re-executions)
    if (window._miniPlayerInitialized && window.startShuffle) {
      return;
    }

    var globalAudio = document.getElementById('global-audio');
    var miniPlayer = document.getElementById('mini-player');
    var miniPlayBtn = document.getElementById('mini-play-btn');
    var miniProgressContainer = document.getElementById('mini-progress-container');
    var miniVolume = document.getElementById('mini-volume');
    var miniSkipBack = document.getElementById('mini-skip-back');
    var miniSkipForward = document.getElementById('mini-skip-forward');
    var miniClose = document.getElementById('mini-close');
    var miniShuffleBtn = document.getElementById('mini-shuffle-btn');

    if (!globalAudio || !miniPlayer) {
      return;
    }

    window._miniPlayerInitialized = true;

    window.globalAudio = globalAudio;

    // Store target volume for fade in/out (global scope so accessible everywhere)
    var shuffleTargetVolume = 1.0;
    var SHUFFLE_FADE_IN_DURATION = 2; // seconds for fade in
    var SHUFFLE_FADE_DURATION = 3; // seconds for fade out
    var shuffleFadingOut = false;

    // Track active fade intervals so we can clean them up between tracks
    var _fadeInInterval = null;
    var _fadeOutInterval = null;

    // Track active event listener refs for cleanup between tracks
    var _currentSeekOnce = null;
    var _currentPlayWhenReady = null;

    // Clear all active fade intervals
    function clearFadeIntervals() {
      if (_fadeInInterval) { clearInterval(_fadeInInterval); _fadeInInterval = null; }
      if (_fadeOutInterval) { clearInterval(_fadeOutInterval); _fadeOutInterval = null; }
    }

    // Fade in new track - accessible from playCurrentShuffleTrack
    function fadeInShuffleTrack() {
      var targetVolume = shuffleTargetVolume || 1.0;
      var fadeSteps = 10;
      var fadeInterval = (SHUFFLE_FADE_IN_DURATION * 1000) / fadeSteps;
      var volumeStep = targetVolume / fadeSteps;
      var step = 0;

      globalAudio.volume = 0;

      // Clear any previous fade-in
      if (_fadeInInterval) clearInterval(_fadeInInterval);

      _fadeInInterval = setInterval(function() {
        step++;
        globalAudio.volume = Math.min(targetVolume, volumeStep * step);

        if (step >= fadeSteps) {
          clearInterval(_fadeInInterval);
          _fadeInInterval = null;
          globalAudio.volume = targetVolume;
        }
      }, fadeInterval);
    }

    // Fade out current track and play next
    function fadeOutAndNext() {
      shuffleTargetVolume = globalAudio.volume || 1.0;
      var startVolume = shuffleTargetVolume;
      var fadeSteps = 15;
      var fadeInterval = (SHUFFLE_FADE_DURATION * 1000) / fadeSteps;
      var volumeStep = startVolume / fadeSteps;
      var step = 0;

      // Clear any previous fade-out
      if (_fadeOutInterval) clearInterval(_fadeOutInterval);

      _fadeOutInterval = setInterval(function() {
        step++;
        globalAudio.volume = Math.max(0, startVolume - (volumeStep * step));

        if (step >= fadeSteps) {
          clearInterval(_fadeOutInterval);
          _fadeOutInterval = null;
          shuffleFadingOut = false;
          playNextShuffleTrack();
        }
      }, fadeInterval);
    }

    // === AUDIO EVENT LISTENERS ===
    if (!globalAudio.hasListeners) {
      globalAudio.hasListeners = true;

      globalAudio.addEventListener('timeupdate', function() {
        var currentTimeEl = document.getElementById('mini-current-time');
        var progressBarEl = document.getElementById('mini-progress-bar');
        if (currentTimeEl) currentTimeEl.textContent = formatTime(globalAudio.currentTime);
        if (globalAudio.duration && progressBarEl) {
          var pct = Math.round(globalAudio.currentTime / globalAudio.duration * 100);
          progressBarEl.style.width = pct + '%';
          var progressContainer = document.getElementById('mini-progress-container');
          if (progressContainer) progressContainer.setAttribute('aria-valuenow', String(pct));
        }
      });

      globalAudio.addEventListener('loadedmetadata', function() {
        var durationEl = document.getElementById('mini-duration');
        if (durationEl) durationEl.textContent = formatTime(globalAudio.duration);
      });

      globalAudio.addEventListener('play', function() {
        var playIcon = document.getElementById('mini-play-icon');
        var pauseIcon = document.getElementById('mini-pause-icon');
        var playBtn = document.getElementById('mini-play-btn');
        if (playIcon) playIcon.classList.add('hidden');
        if (pauseIcon) pauseIcon.classList.remove('hidden');
        if (playBtn) playBtn.setAttribute('aria-pressed', 'true');
        startSpectrum();
        // Announce play state to screen readers
        var liveRegion = document.getElementById('mini-player-live');
        var titleEl = document.getElementById('mini-title');
        if (liveRegion && titleEl && titleEl.textContent !== 'No track loaded') {
          liveRegion.textContent = 'Playing: ' + titleEl.textContent;
        }
      });

      globalAudio.addEventListener('pause', function() {
        var playIcon = document.getElementById('mini-play-icon');
        var pauseIcon = document.getElementById('mini-pause-icon');
        var playBtn = document.getElementById('mini-play-btn');
        if (playIcon) playIcon.classList.remove('hidden');
        if (pauseIcon) pauseIcon.classList.add('hidden');
        if (playBtn) playBtn.setAttribute('aria-pressed', 'false');
        stopSpectrum();
        // Announce pause state to screen readers
        var liveRegion = document.getElementById('mini-player-live');
        var titleEl = document.getElementById('mini-title');
        if (liveRegion && titleEl && titleEl.textContent !== 'No track loaded') {
          liveRegion.textContent = 'Paused: ' + titleEl.textContent;
        }
      });

      globalAudio.addEventListener('ended', function() {
        if (window.FreshWaxPlayer.isShuffleMode) {
          playNextShuffleTrack();
        } else {
          var playIcon = document.getElementById('mini-play-icon');
          var pauseIcon = document.getElementById('mini-pause-icon');
          var playBtn = document.getElementById('mini-play-btn');
          if (playIcon) playIcon.classList.remove('hidden');
          if (pauseIcon) pauseIcon.classList.add('hidden');
          if (playBtn) playBtn.setAttribute('aria-pressed', 'false');
          stopSpectrum();
        }
      });

      // Shuffle mode: play 60 seconds starting from 60s mark (so skip at 120s)
      // With fade out starting 3 seconds before end
      var SHUFFLE_CLIP_END = 120; // Start at 60s, play for 60s, end at 120s
      var SHUFFLE_FADE_START = SHUFFLE_CLIP_END - SHUFFLE_FADE_DURATION;

      globalAudio.addEventListener('timeupdate', function() {
        if (!window.FreshWaxPlayer.isShuffleMode) return;

        // Start fade out 3 seconds before end
        if (globalAudio.currentTime >= SHUFFLE_FADE_START && !shuffleFadingOut) {
          shuffleFadingOut = true;
          fadeOutAndNext();
        }
      });

      globalAudio.addEventListener('error', function(e) {
        console.error('[MINI-PLAYER] Audio error:', e);
        if (window.FreshWaxPlayer.isShuffleMode && !_skipInProgress) {
          _skipInProgress = true;
          // Wait a moment then try next track
          _errorRetryTimer = setTimeout(function() {
            playNextShuffleTrack();
          }, 1500);
        }
      });

      // Handle stalled/waiting events with auto-recovery
      globalAudio.addEventListener('stalled', function() {
        // Try to resume playback after a brief pause
        _stallRecoveryTimer = setTimeout(function() {
          if (globalAudio.paused && globalAudio.src) {
            globalAudio.play().catch(function(err) {
              console.error('[MINI-PLAYER] Stall recovery failed:', err);
            });
          }
        }, 2000);
      });

      globalAudio.addEventListener('waiting', function() {
        // Audio buffering - no action needed
      });

      // Handle network issues with retry logic
      var networkRetryCount = 0;
      var maxNetworkRetries = 5;

      globalAudio.addEventListener('suspend', function() {
        // Browser paused downloading - this is normal
      });

      // Recover from temporary network issues
      window.addEventListener('online', function() {
        if (globalAudio.src && globalAudio.paused && !globalAudio.ended) {
          globalAudio.play().catch(function(err) {
            console.error('[MINI-PLAYER] Resume after network restore failed:', err);
          });
        }
      });
    }

    // === PLAY/PAUSE BUTTON ===
    if (miniPlayBtn) {
      miniPlayBtn.onclick = function() {
        if (!globalAudio.src) return;

        if (globalAudio.paused) {
          // CRITICAL: Stop any playing preview clips FIRST and cancel resume
          if (window.AudioManager) {
            window.AudioManager.stopAllTracklistPreviews();
            window.AudioManager._lockState(150); // Prevent resume from firing
          }

          globalAudio.play().catch(function(err) {
            console.error('[MINI-PLAYER] Play failed:', err);
          });
        } else {
          globalAudio.pause();
        }
      };
    }

    // === SKIP BUTTONS ===
    if (miniSkipBack) {
      miniSkipBack.onclick = function() {
        // Stop any preview clips first
        if (window.AudioManager) {
          window.AudioManager.stopAllTracklistPreviews();
          window.AudioManager.shouldResumeAfterPreview = false;
        }

        if (window.FreshWaxPlayer.isShuffleMode) {
          playPreviousShuffleTrack();
        } else {
          globalAudio.currentTime = Math.max(0, globalAudio.currentTime - 10);
        }
      };
    }

    if (miniSkipForward) {
      miniSkipForward.onclick = function() {
        // Stop any preview clips first
        if (window.AudioManager) {
          window.AudioManager.stopAllTracklistPreviews();
          window.AudioManager.shouldResumeAfterPreview = false;
        }

        if (window.FreshWaxPlayer.isShuffleMode) {
          playNextShuffleTrack();
        } else {
          if (globalAudio.duration) {
            globalAudio.currentTime = Math.min(globalAudio.duration, globalAudio.currentTime + 10);
          }
        }
      };
    }

    // === VOLUME ===
    if (miniVolume) {
      miniVolume.oninput = function() {
        globalAudio.volume = miniVolume.value / 100;
      };
    }

    // === PROGRESS SEEK (Click + Drag) ===
    if (miniProgressContainer) {
      var isDragging = false;
      var progressHandle = document.getElementById('mini-progress-handle');

      function seekToPosition(clientX) {
        if (!globalAudio.duration) return;
        var rect = miniProgressContainer.getBoundingClientRect();
        var progress = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        globalAudio.currentTime = progress * globalAudio.duration;
      }

      function stopPreviewsIfNeeded() {
        if (window.AudioManager) {
          window.AudioManager.stopAllTracklistPreviews();
          window.AudioManager.shouldResumeAfterPreview = false;
        }
      }

      // Click to seek
      miniProgressContainer.addEventListener('click', function(e) {
        if (isDragging) return; // Don't seek on drag end
        stopPreviewsIfNeeded();
        seekToPosition(e.clientX);
      });

      // Drag to seek
      function startDrag(e) {
        if (!globalAudio.duration) return;
        isDragging = true;
        stopPreviewsIfNeeded();
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';

        // Show handle while dragging and disable transition
        if (progressHandle) progressHandle.style.opacity = '1';
        var progressBar = document.getElementById('mini-progress-bar');
        if (progressBar) progressBar.classList.add('dragging');

        // Get initial position
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        seekToPosition(clientX);
      }

      function onDrag(e) {
        if (!isDragging) return;
        e.preventDefault();
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        seekToPosition(clientX);
      }

      function stopDrag() {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Re-enable transition after drag
        var progressBar = document.getElementById('mini-progress-bar');
        if (progressBar) progressBar.classList.remove('dragging');
      }

      // Mouse events
      miniProgressContainer.addEventListener('mousedown', startDrag);
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);

      // Touch events for mobile
      miniProgressContainer.addEventListener('touchstart', startDrag, { passive: false });
      document.addEventListener('touchmove', onDrag, { passive: false });
      document.addEventListener('touchend', stopDrag);
    }

    // === CLOSE BUTTON ===
    if (miniClose) {
      miniClose.onclick = function() {
        globalAudio.pause();
        globalAudio.src = '';
        miniPlayer.classList.remove('visible');
        window.FreshWaxPlayer.currentMix = null;
        window.FreshWaxPlayer.isShuffleMode = false;
        stopSpectrum();

        // Remove active state from both shuffle buttons
        var shuffleBtn = document.getElementById('mini-shuffle-btn');
        var floatingBtn = document.getElementById('floating-shuffle-btn');
        if (shuffleBtn) shuffleBtn.classList.remove('active');
        if (floatingBtn) floatingBtn.classList.remove('active');

        if (window.AudioManager) {
          window.AudioManager.mode = 'idle';
          window.AudioManager.updateShuffleButtonUI(false);
          window.AudioManager.shouldResumeAfterPreview = false;
        }
        updateModeIndicator('');

        var titleEl = document.getElementById('mini-title');
        var djEl = document.getElementById('mini-dj');
        if (titleEl) titleEl.textContent = 'No track loaded';
        if (djEl) djEl.textContent = '--';
      };
    }

    // === SHUFFLE BUTTON ===
    if (miniShuffleBtn) {
      miniShuffleBtn.onclick = function() {
        // Stop any preview clips first
        if (window.AudioManager) {
          window.AudioManager.stopAllTracklistPreviews();
          window.AudioManager.shouldResumeAfterPreview = false;
        }

        if (window.FreshWaxPlayer.isShuffleMode) {
          // Already in shuffle mode - play next random track
          playNextShuffleTrack();
        } else {
          startShuffle();
        }
      };
    }

    // Initialize volume
    if (globalAudio.volume === 1) {
      globalAudio.volume = 0.7;
    }

    // === SHUFFLE FUNCTIONS ===

    function startShuffle() {
      var shuffleBtn = document.getElementById('mini-shuffle-btn');
      var floatingBtn = document.getElementById('floating-shuffle-btn');
      if (shuffleBtn) shuffleBtn.classList.add('loading');
      if (floatingBtn) floatingBtn.classList.add('loading');

      // MOBILE FIX: Unlock audio element in the user gesture context
      var audio = document.getElementById('global-audio');
      if (audio) {
        audio.volume = 0;
        var unlockPlay = audio.play();
        if (unlockPlay) unlockPlay.catch(function() {});
      }

      // Priority 1: Pre-loaded tracks from page
      if (window.SHUFFLE_TRACKS_CACHE && window.SHUFFLE_TRACKS_CACHE.length > 0) {
        window.FreshWaxPlayer.shuffleTracks = window.SHUFFLE_TRACKS_CACHE;
        if (shuffleBtn) shuffleBtn.classList.remove('loading');
        if (floatingBtn) floatingBtn.classList.remove('loading');
        initShufflePlayback();
        return;
      }

      // Priority 2: Previously fetched tracks
      if (window.FreshWaxPlayer.shuffleTracks && window.FreshWaxPlayer.shuffleTracks.length > 0) {
        if (shuffleBtn) shuffleBtn.classList.remove('loading');
        if (floatingBtn) floatingBtn.classList.remove('loading');
        initShufflePlayback();
        return;
      }

      // Priority 3: Fetch from API
      fetch('/api/get-shuffle-tracks/')
        .then(function(res) {
          if (!res.ok) throw new Error('API returned status ' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (shuffleBtn) shuffleBtn.classList.remove('loading');
          if (floatingBtn) floatingBtn.classList.remove('loading');

          if (data.success && data.tracks && data.tracks.length > 0) {
            window.FreshWaxPlayer.shuffleTracks = data.tracks;
            initShufflePlayback();
          } else {
            alert('No preview tracks available for shuffle.');
          }
        })
        .catch(function(err) {
          if (shuffleBtn) shuffleBtn.classList.remove('loading');
          if (floatingBtn) floatingBtn.classList.remove('loading');
          console.error('[MINI-PLAYER] Failed to fetch shuffle tracks:', err);
          alert('Failed to load shuffle tracks.');
        });
    }

    // Expose startShuffle globally
    window.startShuffle = startShuffle;

    function initShufflePlayback() {
      var tracks = window.FreshWaxPlayer.shuffleTracks;

      if (!tracks || tracks.length === 0) {
        console.error('[MINI-PLAYER] No tracks to shuffle');
        return;
      }

      if (window.FreshWaxPlayer.currentMix) {
        window.FreshWaxPlayer.currentMix = null;
      }

      // Fisher-Yates shuffle
      var shuffled = tracks.slice();
      for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
      }

      window.FreshWaxPlayer.shuffledQueue = shuffled;
      window.FreshWaxPlayer.shuffleIndex = 0;
      window.FreshWaxPlayer.isShuffleMode = true;

      // Initialize target volume for fade effects (store current volume or default to 1.0)
      var audio = document.getElementById('global-audio');
      shuffleTargetVolume = (audio && audio.volume > 0) ? audio.volume : 1.0;

      if (window.AudioManager) {
        window.AudioManager.onShufflePlay();
      }

      var shuffleBtn = document.getElementById('mini-shuffle-btn');
      var floatingBtn = document.getElementById('floating-shuffle-btn');
      if (shuffleBtn) shuffleBtn.classList.add('active');
      if (floatingBtn) floatingBtn.classList.add('active');

      var player = document.getElementById('mini-player');
      if (player) player.classList.add('visible');

      updateModeIndicator('SHUFFLE');
      playCurrentShuffleTrack();
    }

    // Guard to prevent double-skip (both error event and play().catch() firing)
    var _skipInProgress = false;

    function playCurrentShuffleTrack() {
      var queue = window.FreshWaxPlayer.shuffledQueue;
      var index = window.FreshWaxPlayer.shuffleIndex;

      // Reset ALL state for new track
      _skipInProgress = false;
      shuffleFadingOut = false;
      clearTimeout(_shuffleRetryTimer);
      clearFadeIntervals();

      // Clean up stale event listeners from previous track
      var audio = document.getElementById('global-audio');
      if (audio) {
        if (_currentSeekOnce) { audio.removeEventListener('loadedmetadata', _currentSeekOnce); _currentSeekOnce = null; }
        if (_currentPlayWhenReady) { audio.removeEventListener('canplay', _currentPlayWhenReady); _currentPlayWhenReady = null; }
      }

      if (!queue || queue.length === 0) {
        console.error('[MINI-PLAYER] Empty shuffle queue');
        return;
      }

      // Wrap around
      if (index >= queue.length) {
        window.FreshWaxPlayer.shuffleIndex = 0;
        index = 0;
        for (var i = queue.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var temp = queue[i];
          queue[i] = queue[j];
          queue[j] = temp;
        }
      }

      var track = queue[index];
      if (!track) {
        console.error('[MINI-PLAYER] No track at index', index);
        return;
      }

      var trackTitle = track.title || track.trackName || track.name || 'Unknown Track';
      var trackArtist = track.artist || track.artistName || 'Unknown Artist';
      var trackArtwork = track.thumbUrl || track.artwork || track.coverArtUrl || track.artworkUrl || '/place-holder.webp';
      var trackAudioUrl = track.previewUrl || track.audioUrl || track.mp3Url;
      var trackReleaseId = track.releaseId || '';

      var titleEl = document.getElementById('mini-title');
      var djEl = document.getElementById('mini-dj');
      var artworkEl = document.getElementById('mini-artwork');
      var artworkLink = document.getElementById('mini-artwork-link');
      var infoLink = document.getElementById('mini-info-link');

      // Truncate title to 30 characters
      var displayTitle = trackTitle.length > 30 ? trackTitle.substring(0, 27) + '...' : trackTitle;
      if (titleEl) titleEl.textContent = displayTitle;
      if (djEl) djEl.textContent = trackArtist;
      if (artworkEl) artworkEl.src = trackArtwork;
      // Announce track change to screen readers
      var liveRegion = document.getElementById('mini-player-live');
      if (liveRegion) liveRegion.textContent = 'Now playing: ' + trackTitle + ' by ' + trackArtist;

      var releaseUrl = trackReleaseId ? '/item/' + trackReleaseId + '/' : '#';
      if (artworkLink) artworkLink.href = releaseUrl;
      if (infoLink) infoLink.href = releaseUrl;

      if (!trackAudioUrl) {
        console.error('[MINI-PLAYER] Track has no audio URL, skipping');
        _shuffleRetryTimer = setTimeout(function() {
          playNextShuffleTrack();
        }, 200);
        return;
      }

      // Add cache-busting param to bypass CDN cached responses without CORS headers
      if (trackAudioUrl.indexOf('cdn.freshwax.co.uk') > -1 && trackAudioUrl.indexOf('?') === -1) {
        trackAudioUrl = trackAudioUrl + '?v=2';
      }

      var audio = document.getElementById('global-audio');
      if (audio) {
        // Remove crossorigin for shuffle to avoid CORS issues with R2 CDN
        // (spectrum analyser won't work without it, but audio will play)
        audio.removeAttribute('crossorigin');

        // Start with volume 0 for fade in effect
        audio.volume = 0;
        audio.src = trackAudioUrl;
        audio.load();

        // Shuffle mode: start 60 seconds into the track
        var SHUFFLE_START_TIME = 60;

        // Wait for audio to be ready, then seek to start position
        _currentSeekOnce = function() {
          if (audio.duration && audio.duration > SHUFFLE_START_TIME + 10) {
            audio.currentTime = SHUFFLE_START_TIME;
          } else if (audio.duration && audio.duration > 30) {
            // If track is shorter than 70s, start at 30% into track
            audio.currentTime = audio.duration * 0.3;
          }
          audio.removeEventListener('loadedmetadata', _currentSeekOnce);
          _currentSeekOnce = null;
        };
        audio.addEventListener('loadedmetadata', _currentSeekOnce);

        // Wait for enough data to play before calling play()
        _currentPlayWhenReady = function() {
          audio.removeEventListener('canplay', _currentPlayWhenReady);
          _currentPlayWhenReady = null;
          clearTimeout(_shuffleRetryTimer);
          audio.play().then(function() {
            fadeInShuffleTrack();
          }).catch(function(err) {
            console.error('[MINI-PLAYER] Shuffle play error:', err);
            audio.volume = shuffleTargetVolume || 1.0;
            if (!_skipInProgress) {
              _skipInProgress = true;
              _shuffleRetryTimer = setTimeout(function() {
                playNextShuffleTrack();
              }, 1500);
            }
          });
        };
        audio.addEventListener('canplay', _currentPlayWhenReady);

        // Fallback: if canplay doesn't fire within 8 seconds, skip
        _shuffleRetryTimer = setTimeout(function() {
          if (_currentPlayWhenReady) {
            audio.removeEventListener('canplay', _currentPlayWhenReady);
            _currentPlayWhenReady = null;
          }
          if (!_skipInProgress) {
            _skipInProgress = true;
            console.error('[MINI-PLAYER] Track load timeout, skipping');
            playNextShuffleTrack();
          }
        }, 8000);
      }
    }

    function playNextShuffleTrack() {
      window.FreshWaxPlayer.shuffleIndex++;
      playCurrentShuffleTrack();
    }

    // Expose globally for floating shuffle button
    window.playNextShuffleTrack = playNextShuffleTrack;

    function playPreviousShuffleTrack() {
      var audio = document.getElementById('global-audio');
      if (audio && audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
      }
      window.FreshWaxPlayer.shuffleIndex = Math.max(0, window.FreshWaxPlayer.shuffleIndex - 1);
      playCurrentShuffleTrack();
    }

    function stopShuffle() {
      window.FreshWaxPlayer.isShuffleMode = false;

      var audio = document.getElementById('global-audio');
      if (audio) audio.pause();

      if (window.AudioManager) {
        window.AudioManager.onShuffleStop();
      }

      var shuffleBtn = document.getElementById('mini-shuffle-btn');
      var floatingBtn = document.getElementById('floating-shuffle-btn');
      if (shuffleBtn) shuffleBtn.classList.remove('active');
      if (floatingBtn) floatingBtn.classList.remove('active');

      updateModeIndicator('');
      var titleEl = document.getElementById('mini-title');
      var djEl = document.getElementById('mini-dj');
      if (titleEl) titleEl.textContent = 'No track loaded';
      if (djEl) djEl.textContent = '--';

      if (!window.FreshWaxPlayer.currentMix) {
        var player = document.getElementById('mini-player');
        if (player) player.classList.remove('visible');
      }
    }

    function updateModeIndicator(mode) {
      var indicator = document.getElementById('mini-mode-indicator');
      if (indicator) {
        if (mode) {
          indicator.textContent = mode;
          indicator.classList.add('has-mode');
        } else {
          indicator.classList.remove('has-mode');
        }
      }
    }

    // === PLAY MIX FUNCTION (for DJ mixes) ===
    window.playMix = function(mixData) {
      if (!mixData || !mixData.audio_url) {
        console.error('[MINI-PLAYER] Invalid mixData');
        return Promise.reject('Invalid mix data');
      }

      // Restore crossorigin for DJ mixes (needed for spectrum analyser)
      var audio = document.getElementById('global-audio');
      if (audio && !audio.getAttribute('crossorigin')) {
        audio.setAttribute('crossorigin', 'anonymous');
      }

      // Stop any preview clips first
      if (window.AudioManager) {
        window.AudioManager.stopAllTracklistPreviews();
        window.AudioManager.shouldResumeAfterPreview = false;
      }

      if (window.FreshWaxPlayer.isShuffleMode) {
        window.FreshWaxPlayer.isShuffleMode = false;
        var shuffleBtn = document.getElementById('mini-shuffle-btn');
        var floatingBtn = document.getElementById('floating-shuffle-btn');
        if (shuffleBtn) shuffleBtn.classList.remove('active');
        if (floatingBtn) floatingBtn.classList.remove('active');
        if (window.AudioManager) {
          window.AudioManager.updateShuffleButtonUI(false);
        }
      }

      if (window.AudioManager) {
        window.AudioManager.onDjMixPlay();
      }

      var isSameMix = window.FreshWaxPlayer.currentMix && window.FreshWaxPlayer.currentMix.id === mixData.id;
      var player = document.getElementById('mini-player');
      var audio = document.getElementById('global-audio');

      if (!isSameMix) {
        window.FreshWaxPlayer.currentMix = mixData;
        window.FreshWaxPlayer.hasTrackedPlay = false;

        // Set source and preload for smooth playback
        // Add cache-busting param to bypass CDN cached responses without CORS headers
        var audioUrl = mixData.audio_url;
        if (audioUrl.indexOf('cdn.freshwax.co.uk') > -1 && audioUrl.indexOf('?') === -1) {
          audioUrl = audioUrl + '?v=2';
        }
        audio.src = audioUrl;
        audio.preload = 'auto';
        audio.load();

        var titleEl = document.getElementById('mini-title');
        var djEl = document.getElementById('mini-dj');
        var artworkEl = document.getElementById('mini-artwork');
        var artworkLink = document.getElementById('mini-artwork-link');
        var infoLink = document.getElementById('mini-info-link');

        if (titleEl) {
          var mixTitle = mixData.title || 'Unknown Mix';
          titleEl.textContent = mixTitle.length > 30 ? mixTitle.substring(0, 27) + '...' : mixTitle;
        }
        if (djEl) djEl.textContent = mixData.dj_name || 'Unknown DJ';
        if (artworkEl) artworkEl.src = mixData.artwork_url || '/place-holder.webp';
        // Announce DJ mix to screen readers
        var liveRegion = document.getElementById('mini-player-live');
        if (liveRegion) liveRegion.textContent = 'Now playing: ' + (mixData.title || 'Unknown Mix') + ' by ' + (mixData.dj_name || 'Unknown DJ');
        if (artworkLink) artworkLink.href = '/dj-mix/' + mixData.id;
        if (infoLink) infoLink.href = '/dj-mix/' + mixData.id;

        updateModeIndicator('DJ MIX');
      }

      if (player) player.classList.add('visible');

      return audio.play().then(function() {
      }).catch(function(err) {
        console.error('[MINI-PLAYER] Play error:', err);
        throw err;
      });
    };

  }

  // Clean up pending timers on View Transitions to prevent stale callbacks
  document.addEventListener('astro:before-swap', function() {
    clearTimeout(_errorRetryTimer);
    clearTimeout(_stallRecoveryTimer);
    clearTimeout(_shuffleRetryTimer);
  });

  // Initialize — astro:page-load fires on both initial load and View Transitions
  document.addEventListener('astro:page-load', initMiniPlayer);
})();
