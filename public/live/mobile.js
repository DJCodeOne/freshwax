// public/live/mobile.js
// Live page — mobile tabs, mini player, keyboard shortcuts, touch gestures, playlist save

export function initMobile() {
  setupMobileTabs();
  setupMiniPlayer();
  setupKeyboardShortcuts();
  setupTouchGestures();
  setupPlaylistSave();
}

function setupMobileTabs() {
  var mobileTabs = document.querySelectorAll('.mobile-tab');
  var mobileTabArr = Array.prototype.slice.call(mobileTabs);
  var scheduleColumn = document.querySelector('.schedule-column');
  var playerColumn = document.querySelector('.player-column');
  var chatColumn = document.querySelector('.chat-column');
  var tabNames = ['player', 'chat', 'schedule'];

  function switchMobileTab(tabName, moveFocus) {
    mobileTabs.forEach(function(tab) {
      var isActive = tab.dataset.tab === tabName;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
      if (moveFocus && isActive) tab.focus();
    });

    if (scheduleColumn) {
      scheduleColumn.classList.toggle('mobile-active', tabName === 'schedule');
      scheduleColumn.setAttribute('tabindex', tabName === 'schedule' ? '0' : '-1');
    }
    if (playerColumn) {
      playerColumn.classList.toggle('mobile-active', tabName === 'player');
      playerColumn.setAttribute('tabindex', tabName === 'player' ? '0' : '-1');
    }
    if (chatColumn) {
      chatColumn.classList.toggle('mobile-active', tabName === 'chat');
      chatColumn.setAttribute('tabindex', tabName === 'chat' ? '0' : '-1');
    }

    if (tabName === 'chat') {
      var chatBadge = document.querySelector('.mobile-tab[data-tab="chat"] .tab-badge');
      if (chatBadge) chatBadge.remove();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  mobileTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      switchMobileTab(tab.dataset.tab, false);
    });
  });

  // Arrow key navigation within tablist
  var tablist = document.getElementById('mobileTabs');
  if (tablist) {
    tablist.addEventListener('keydown', function(e) {
      var idx = mobileTabArr.indexOf(document.activeElement);
      if (idx === -1) return;
      var newIdx = idx;
      if (e.key === 'ArrowRight') {
        newIdx = (idx + 1) % mobileTabArr.length;
      } else if (e.key === 'ArrowLeft') {
        newIdx = (idx - 1 + mobileTabArr.length) % mobileTabArr.length;
      } else if (e.key === 'Home') {
        newIdx = 0;
      } else if (e.key === 'End') {
        newIdx = mobileTabArr.length - 1;
      } else {
        return;
      }
      e.preventDefault();
      switchMobileTab(mobileTabArr[newIdx].dataset.tab, true);
    });
  }

  // Set initial state — player active by default on mobile
  if (window.innerWidth <= 900 && playerColumn) {
    playerColumn.classList.add('mobile-active');
  }

  // Chat notification badge
  window.notifyNewChatMessage = function() {
    var chatTab = document.querySelector('.mobile-tab[data-tab="chat"]');
    if (!chatTab || chatTab.classList.contains('active')) return;

    var badge = chatTab.querySelector('.tab-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = '1';
      chatTab.appendChild(badge);
    } else {
      var count = parseInt(badge.textContent) + 1;
      badge.textContent = count > 9 ? '9+' : count;
    }
  };
}

function setupMiniPlayer() {
  var miniPlayer = document.getElementById('miniPlayer');
  var miniPlayBtn = document.getElementById('miniPlayBtn');
  var miniExpandBtn = document.getElementById('miniExpandBtn');
  var miniPlayIcon = document.getElementById('miniPlayIcon');
  var miniPauseIcon = document.getElementById('miniPauseIcon');
  var miniDjName = document.getElementById('miniDjName');
  var miniDjAvatar = document.getElementById('miniDjAvatar');
  var miniLedStrip = document.getElementById('miniLedStrip');
  var playerContainer = document.getElementById('playerContainer');

  var miniPlayerVisible = false;

  function updateMiniPlayer() {
    if (!playerContainer || !miniPlayer) return;

    var rect = playerContainer.getBoundingClientRect();
    var shouldShow = rect.bottom < 0 && window.innerWidth <= 768;

    if (shouldShow && !miniPlayerVisible) {
      miniPlayer.classList.remove('hidden');
      setTimeout(function() { miniPlayer.classList.add('visible'); }, 10);
      miniPlayerVisible = true;
    } else if (!shouldShow && miniPlayerVisible) {
      miniPlayer.classList.remove('visible');
      setTimeout(function() { miniPlayer.classList.add('hidden'); }, 300);
      miniPlayerVisible = false;
    }
  }

  function syncMiniPlayer() {
    var playBtn = document.getElementById('playBtn');
    var djName = document.getElementById('djName');
    var djAvatar = document.getElementById('djAvatar');

    if (playBtn && miniPlayBtn) {
      var isPlaying = playBtn.classList.contains('playing');
      if (isPlaying) {
        if (miniPlayIcon) miniPlayIcon.classList.add('hidden');
        if (miniPauseIcon) miniPauseIcon.classList.remove('hidden');
      } else {
        if (miniPlayIcon) miniPlayIcon.classList.remove('hidden');
        if (miniPauseIcon) miniPauseIcon.classList.add('hidden');
      }
    }

    if (djName && miniDjName) {
      miniDjName.textContent = djName.textContent;
    }

    if (djAvatar && miniDjAvatar) {
      miniDjAvatar.src = djAvatar.src;
    }
  }

  // Mini player play/pause
  if (miniPlayBtn) {
    miniPlayBtn.addEventListener('click', function() {
      var playBtn = document.getElementById('playBtn');
      if (playBtn) playBtn.click();
      syncMiniPlayer();
    });
  }

  // Expand back to full player
  if (miniExpandBtn) {
    miniExpandBtn.addEventListener('click', function() {
      if (playerContainer) playerContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Throttled scroll handler
  var scrollTimeout;
  function handleScroll() {
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(function() {
      updateMiniPlayer();
      scrollTimeout = null;
    }, 100);
  }
  window.addEventListener('scroll', handleScroll, { passive: true });

  // Store handleScroll for cleanup
  window._liveHandleScroll = handleScroll;

  // Observe play state changes
  var playBtn = document.getElementById('playBtn');
  if (playBtn) {
    var miniPlayerObserver = new MutationObserver(syncMiniPlayer);
    miniPlayerObserver.observe(playBtn, { attributes: true, attributeFilter: ['class'] });

    document.addEventListener('astro:before-swap', function() {
      miniPlayerObserver.disconnect();
    }, { once: true });
  }
}

function setupKeyboardShortcuts() {
  function handleKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch(e.code) {
      case 'Space':
        e.preventDefault();
        var pb = document.getElementById('playBtn');
        if (pb) pb.click();
        break;
      case 'KeyM':
        var slider = document.getElementById('volumeSlider');
        if (slider) {
          slider.value = slider.value > 0 ? 0 : 80;
          slider.dispatchEvent(new Event('input'));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        adjustVolume(10);
        break;
      case 'ArrowDown':
        e.preventDefault();
        adjustVolume(-10);
        break;
      case 'KeyF':
        var fsBtn = document.getElementById('fullscreenBtn');
        if (fsBtn) fsBtn.click();
        break;
    }
  }
  document.addEventListener('keydown', handleKeydown);

  // Store for cleanup
  window._liveHandleKeydown = handleKeydown;

  // Cleanup on View Transitions navigation
  document.addEventListener('astro:before-swap', function() {
    if (window._liveHandleScroll) window.removeEventListener('scroll', window._liveHandleScroll);
    document.removeEventListener('keydown', handleKeydown);
  }, { once: true });
}

function adjustVolume(delta) {
  var slider = document.getElementById('volumeSlider');
  if (slider) {
    var newVal = parseInt(slider.value) + delta;
    newVal = Math.max(0, Math.min(100, newVal));
    slider.value = newVal;
    slider.dispatchEvent(new Event('input'));
    showVolumeHint(newVal);
  }
}

function showVolumeHint(vol) {
  var hint = document.getElementById('volumeHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'volumeHint';
    hint.className = 'swipe-hint';
    document.body.appendChild(hint);
  }
  hint.textContent = 'Volume: ' + vol + '%';
  hint.classList.add('visible');
  setTimeout(function() { hint.classList.remove('visible'); }, 1000);
}

function setupTouchGestures() {
  var playerContainer = document.getElementById('playerContainer');
  var touchStartY = 0;
  var touchStartX = 0;

  if (playerContainer) {
    playerContainer.addEventListener('touchstart', function(e) {
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    playerContainer.addEventListener('touchend', function(e) {
      var touchEndY = e.changedTouches[0].clientY;
      var touchEndX = e.changedTouches[0].clientX;
      var deltaY = touchStartY - touchEndY;
      var deltaX = touchEndX - touchStartX;

      if (Math.abs(deltaY) > 50 && Math.abs(deltaY) > Math.abs(deltaX)) {
        var volumeChange = deltaY > 0 ? 10 : -10;
        adjustVolume(volumeChange);
      }
    }, { passive: true });

    // Double tap to trigger reaction
    var lastTap = 0;
    playerContainer.addEventListener('touchend', function(e) {
      var now = Date.now();
      if (now - lastTap < 300) {
        var likeBtn = document.getElementById('likeBtn');
        if (likeBtn) likeBtn.click();
      }
      lastTap = now;
    }, { passive: true });
  }
}

function setupPlaylistSave() {
  var nowPlayingSaveBtn = document.getElementById('nowPlayingSaveBtn');
  var currentPlaylistTrack = null;

  // Listen for playlist updates — only handle save button state here.
  // DJ info bar DOM updates (controlsDjName, npTrackTitle, bottomDurationBox, etc.)
  // are handled by live-stream.js handlePlaylistUpdate() as the single source of truth.
  window.addEventListener('playlistUpdate', function(e) {
    var detail = e.detail;
    var isPlaylistPlaying = detail.isPlaying && detail.queue && detail.queue.length > 0;

    if (isPlaylistPlaying) {
      var currentIndex = detail.currentIndex || 0;
      currentPlaylistTrack = detail.queue[currentIndex];

      if (nowPlayingSaveBtn && currentPlaylistTrack) {
        var personalPlaylist = detail.personalPlaylist || [];
        var isInPlaylist = personalPlaylist.some(function(item) { return item.url === currentPlaylistTrack.url; });
        nowPlayingSaveBtn.classList.toggle('saved', isInPlaylist);
        nowPlayingSaveBtn.title = isInPlaylist ? 'Already in My Playlist' : 'Save to My Playlist';
      }
    } else {
      currentPlaylistTrack = null;
    }
  });

  // Handle save button click
  if (nowPlayingSaveBtn) {
    nowPlayingSaveBtn.addEventListener('click', async function() {
      if (!currentPlaylistTrack) return;
      if (nowPlayingSaveBtn.classList.contains('saved')) return;

      try {
        var manager = window.playlistManager;
        if (manager) {
          var result = await manager.addToPersonalPlaylist(currentPlaylistTrack.url);
          if (result.success) {
            nowPlayingSaveBtn.classList.add('saved');
            nowPlayingSaveBtn.title = 'Already in My Playlist';
          }
        } else {
          /* playlist manager not available */
        }
      } catch (err) {
        console.error('[NowPlaying] Error saving track:', err);
      }
    });
  }
}
