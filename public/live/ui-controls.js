// public/live/ui-controls.js
// Live page — volume, fullscreen, mobile device detection, orientation, visibility

var touchStartY = 0;
var touchStartVolume = 0;
var volumeSliderHandler = null;
var touchVolumeHandlers = null;
var mobileListenersAttached = false;

// Callbacks set by orchestrator
var _onVisibilityReturn = null;

export function initUiControls(deps) {
  if (deps.onVisibilityReturn) _onVisibilityReturn = deps.onVisibilityReturn;
}

export function detectMobileDevice() {
  var isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  document.body.classList.toggle('is-mobile', isMobile);
  document.body.classList.toggle('is-touch', isTouch);
  window.isMobileDevice = isMobile;
  window.isTouchDevice = isTouch;
}

export function setupVolumeSlider() {
  var slider = document.getElementById('volumeSlider');
  if (!slider) return;
  if (volumeSliderHandler) slider.removeEventListener('input', volumeSliderHandler);
  volumeSliderHandler = function(e) {
    var val = parseInt(e.target.value);
    var videoEl = document.getElementById('hlsVideoElement');
    if (videoEl) videoEl.volume = val / 100;
    var audioEl = document.getElementById('audioElement');
    if (audioEl) audioEl.volume = val / 100;
    if (window.playlistManager) window.playlistManager.setVolume(val);
    if (window.embedPlayerManager) window.embedPlayerManager.setVolume(val);
  };
  slider.addEventListener('input', volumeSliderHandler);
}

export function setupMobileFeatures() {
  var playerColumn = document.querySelector('.player-column');
  if (playerColumn) {
    playerColumn.addEventListener('touchmove', function(e) {
      if (e.touches.length === 1) e.stopPropagation();
    }, { passive: true });
  }
  setupTouchVolumeControl();
  if (mobileListenersAttached) {
    window.removeEventListener('orientationchange', handleOrientationChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  window.addEventListener('orientationchange', handleOrientationChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  mobileListenersAttached = true;
}

function setupTouchVolumeControl() {
  var wrapper = document.querySelector('.player-wrapper');
  if (!wrapper || !window.isTouchDevice) return;
  if (touchVolumeHandlers) {
    wrapper.removeEventListener('touchstart', touchVolumeHandlers.start);
    wrapper.removeEventListener('touchmove', touchVolumeHandlers.move);
    wrapper.removeEventListener('touchend', touchVolumeHandlers.end);
  }
  touchVolumeHandlers = {
    start: function(e) {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        var slider = document.getElementById('volumeSlider');
        touchStartVolume = slider ? parseInt(slider.value) : 80;
      }
    },
    move: function(e) {
      if (e.touches.length === 1 && touchStartY) {
        var delta = touchStartY - e.touches[0].clientY;
        var volDelta = Math.round(delta / 3);
        var newVol = Math.max(0, Math.min(100, touchStartVolume + volDelta));
        var slider = document.getElementById('volumeSlider');
        if (slider) {
          slider.value = newVol;
          slider.dispatchEvent(new Event('input'));
          showVolumeIndicator(newVol);
        }
      }
    },
    end: function() {
      touchStartY = 0;
      hideVolumeIndicator();
    }
  };
  wrapper.addEventListener('touchstart', touchVolumeHandlers.start, { passive: true });
  wrapper.addEventListener('touchmove', touchVolumeHandlers.move, { passive: true });
  wrapper.addEventListener('touchend', touchVolumeHandlers.end, { passive: true });
}

function showVolumeIndicator(vol) {
  var indicator = document.getElementById('volumeIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'volumeIndicator';
    indicator.style.cssText = '\n      position: fixed;\n      top: 50%;\n      left: 50%;\n      transform: translate(-50%, -50%);\n      background: rgba(0,0,0,0.8);\n      color: #fff;\n      padding: 1rem 2rem;\n      border-radius: 12px;\n      font-size: 1.5rem;\n      font-weight: bold;\n      z-index: 9999;\n      pointer-events: none;\n      transition: opacity 0.2s;\n    ';
    document.body.appendChild(indicator);
  }
  indicator.textContent = '\u{1F50A} ' + vol + '%';
  indicator.style.opacity = '1';
}

function hideVolumeIndicator() {
  var indicator = document.getElementById('volumeIndicator');
  if (indicator) {
    indicator.style.opacity = '0';
    setTimeout(function() { indicator.remove(); }, 200);
  }
}

function handleOrientationChange() {
  setTimeout(function() {
    var isLandscape = window.innerWidth > window.innerHeight;
    document.body.classList.toggle('landscape', isLandscape);
    var video = document.getElementById('hlsVideoElement');
    // isPlaying check: use window-level state
    if (video && window.isLiveStreamActive) {
      video.style.maxHeight = isLandscape ? '100vh' : '56.25vw';
    }
  }, 100);
}

function handleVisibilityChange() {
  if (document.hidden) return;
  if (_onVisibilityReturn) _onVisibilityReturn();
}

export function cleanupUiControls() {
  if (mobileListenersAttached) {
    window.removeEventListener('orientationchange', handleOrientationChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    mobileListenersAttached = false;
  }
  var wrapper = document.querySelector('.player-wrapper');
  if (wrapper && touchVolumeHandlers) {
    wrapper.removeEventListener('touchstart', touchVolumeHandlers.start);
    wrapper.removeEventListener('touchmove', touchVolumeHandlers.move);
    wrapper.removeEventListener('touchend', touchVolumeHandlers.end);
    touchVolumeHandlers = null;
  }
  var slider = document.getElementById('volumeSlider');
  if (slider && volumeSliderHandler) {
    slider.removeEventListener('input', volumeSliderHandler);
    volumeSliderHandler = null;
  }
}
