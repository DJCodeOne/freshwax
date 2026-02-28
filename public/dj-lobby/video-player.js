// public/dj-lobby/video-player.js
// DJ Lobby — HLS.js player, OBS/BUTT preview, source switching, stream health, relay health

var ctx = null;

// Module-local state
var hlsPlayer = null;
var currentHlsUrl = null;
var isVideoPlaying = false;
var healthInterval = null;
var obsHlsPlayer = null;
var currentObsPreviewUrl = null;
var obsPreviewCheckInterval = null;
var obsPreviewFailCount = 0;
var OBS_PREVIEW_MAX_FAILS = 30;
var userIsStreaming = false;
var icecastCheckInterval = null;
var icecastStreamConnected = false;
var icecastProbeAudio = null;
var icecastConnected = false;
var currentPreviewSource = 'obs';
var buttAudioSource = 'preview';
var broadcastAudioSource = 'preview';
var broadcastMode = 'placeholder';
var obsConnected = false;

// Icecast audio context and analysers
var icecastAudioContext = null;
var icecastAnalyserL = null;
var icecastAnalyserR = null;
var icecastKWeightedAnalyserL = null;
var icecastKWeightedAnalyserR = null;
var icecastGainNode = null;

// Stream timing
var streamStartTime = null;
var streamEndTime = null;
var isFadingOut = false;

export function init(context) {
  ctx = context;
}

// Getters/setters for main script
export function getHlsPlayer() { return hlsPlayer; }
export function setHlsPlayer(val) { hlsPlayer = val; }
export function getCurrentHlsUrl() { return currentHlsUrl; }
export function setCurrentHlsUrl(val) { currentHlsUrl = val; }
export function getIsVideoPlaying() { return isVideoPlaying; }
export function setIsVideoPlaying(val) { isVideoPlaying = val; }
export function getObsHlsPlayer() { return obsHlsPlayer; }
export function getCurrentObsPreviewUrl() { return currentObsPreviewUrl; }
export function getObsPreviewCheckInterval() { return obsPreviewCheckInterval; }
export function getUserIsStreaming() { return userIsStreaming; }
export function setUserIsStreaming(val) { userIsStreaming = val; }
export function getCurrentPreviewSource() { return currentPreviewSource; }
export function setCurrentPreviewSourceDirect(val) { currentPreviewSource = val; }
export function getBroadcastAudioSource() { return broadcastAudioSource; }
export function setBroadcastAudioSource(val) { broadcastAudioSource = val; }
export function getBroadcastMode() { return broadcastMode; }
export function setBroadcastModeDirect(val) { broadcastMode = val; }
export function getObsConnected() { return obsConnected; }
export function setObsConnected(val) { obsConnected = val; }
export function getIcecastAudioContext() { return icecastAudioContext; }
export function getIcecastAnalyserL() { return icecastAnalyserL; }
export function getIcecastAnalyserR() { return icecastAnalyserR; }
export function getIcecastKWeightedAnalyserL() { return icecastKWeightedAnalyserL; }
export function getIcecastKWeightedAnalyserR() { return icecastKWeightedAnalyserR; }
export function getIcecastGainNode() { return icecastGainNode; }
export function getStreamStartTime() { return streamStartTime; }
export function setStreamStartTime(val) { streamStartTime = val; }
export function getStreamEndTime() { return streamEndTime; }
export function setStreamEndTime(val) { streamEndTime = val; }
export function getIsFadingOut() { return isFadingOut; }
export function setIsFadingOut(val) { isFadingOut = val; }
export function getIcecastConnected() { return icecastConnected; }

function normalizeHlsUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  // Fix old trycloudflare.com URLs to correct base
  return rawUrl.replace(/https?:\/\/[^/]*\.trycloudflare\.com/, 'https://stream.freshwax.co.uk');
}

export function setupHlsPlayer(stream) {
  var videoElement = document.getElementById('hlsVideo');
  var rawHlsUrl = stream ? (stream.hlsUrl || stream.videoStreamUrl || stream.streamUrl) : null;
  var hlsUrl = normalizeHlsUrl(rawHlsUrl);
  var log = ctx ? ctx.log : function() {};

  if (!videoElement || !hlsUrl) {
    log('[HLS] No video element or stream URL. Stream: ' + JSON.stringify(stream));
    return;
  }

  if (currentHlsUrl === hlsUrl && hlsPlayer) {
    if (!videoElement.paused && isVideoPlaying) {
      log('[HLS] Already playing this stream, skipping re-init');
      return;
    }
    log('[HLS] Same stream but not playing, attempting to play...');
    videoElement.play().catch(function(e) {
      log('[HLS] Auto-play blocked, user interaction required: ' + e.message);
    });
    return;
  }

  log('[HLS] Setting up player for: ' + hlsUrl);
  currentHlsUrl = hlsUrl;

  if (hlsPlayer) {
    log('[HLS] Destroying existing player');
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  var nativeHlsSupport = videoElement.canPlayType('application/vnd.apple.mpegurl');

  if (nativeHlsSupport === 'probably') {
    log('[HLS] Using native HLS support');
    videoElement.src = hlsUrl;
    videoElement.play().catch(function(e) {
      log('[HLS] Auto-play blocked (native), user interaction required: ' + e.message);
    });
  } else if (window.Hls && Hls.isSupported()) {
    log('[HLS] Using HLS.js library');
    hlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      maxBufferLength: 30,
      maxMaxBufferLength: 60
    });

    hlsPlayer.loadSource(hlsUrl);
    hlsPlayer.attachMedia(videoElement);

    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
      log('[HLS] Manifest parsed, auto-playing...');
      triggerStreamFadeIn();
      videoElement.play().catch(function(e) {
        log('[HLS] Auto-play blocked, user interaction required: ' + e.message);
      });
    });

    hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
      console.error('[HLS] Error:', data.type, data.details);
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log('[HLS] Network error, will retry...');
          setTimeout(function() {
            if (hlsPlayer) {
              hlsPlayer.loadSource(hlsUrl);
            }
          }, 3000);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          log('[HLS] Media error, recovering...');
          hlsPlayer.recoverMediaError();
        }
      }
    });
  } else {
    console.error('[HLS] Not supported');
  }

  videoElement.addEventListener('play', function() {
    isVideoPlaying = true;
    var playIcon = document.getElementById('playIcon');
    var pauseIcon = document.getElementById('pauseIcon');
    if (playIcon) playIcon.classList.add('hidden');
    if (pauseIcon) pauseIcon.classList.remove('hidden');
    startHealthMonitoring();
  });

  videoElement.addEventListener('pause', function() {
    isVideoPlaying = false;
    var playIcon = document.getElementById('playIcon');
    var pauseIcon = document.getElementById('pauseIcon');
    if (playIcon) playIcon.classList.remove('hidden');
    if (pauseIcon) pauseIcon.classList.add('hidden');
    stopHealthMonitoring();
  });
}

export function cleanupHlsPlayer() {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  currentHlsUrl = null;
  isVideoPlaying = false;
}

// Server and OBS indicators
export function updateServerIndicator(isConnected) {
  var dot = document.getElementById('serverDot');
  if (dot) {
    dot.className = 'indicator-dot ' + (isConnected ? 'connected' : 'disconnected');
  }
}

export function updateObsIndicator(isConnected) {
  var dot = document.getElementById('obsDot');
  var box = document.getElementById('obsIndicator');
  var previewDot = document.getElementById('previewObsDot');
  if (dot) {
    dot.className = 'indicator-dot ' + (isConnected ? 'connected' : 'disconnected');
  }
  if (previewDot) {
    previewDot.className = 'indicator-dot ' + (isConnected ? 'connected' : 'disconnected');
  }
  if (box) {
    box.classList.toggle('connected', isConnected);
    box.classList.toggle('disconnected', !isConnected);
  }
  obsConnected = isConnected;
  updateBroadcastModeUI();
}

export function updateBroadcastModeUI() {
  var toggleContainer = document.getElementById('broadcastModeToggle');
  var toggleLabel = document.getElementById('liveOutputToggleLabel');

  var isButtActive = currentPreviewSource === 'butt';

  if (isButtActive && obsConnected) {
    if (toggleContainer) toggleContainer.classList.remove('hidden');
    if (toggleLabel) toggleLabel.textContent = broadcastMode === 'placeholder' ? 'Placeholder' : 'OBS Video';
  } else if (isButtActive && !obsConnected) {
    if (toggleContainer) toggleContainer.classList.add('hidden');
    if (broadcastMode !== 'placeholder') {
      setBroadcastMode('placeholder');
    }
  } else if (!isButtActive && obsConnected) {
    if (toggleContainer) toggleContainer.classList.add('hidden');
    if (broadcastMode !== 'video') {
      setBroadcastMode('video');
    }
  } else {
    if (toggleContainer) toggleContainer.classList.add('hidden');
  }
}

export async function setBroadcastMode(mode) {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  broadcastMode = mode;
  var toggleLabel = document.getElementById('liveOutputToggleLabel');

  if (toggleLabel) {
    toggleLabel.textContent = mode === 'placeholder' ? 'Placeholder' : 'OBS Video';
  }
  console.debug('[Broadcast] Mode set to:', mode);

  if (currentStream && currentStream.id) {
    try {
      var hlsBaseUrl = 'https://stream.freshwax.co.uk/live';
      var hlsUrl;

      if (mode === 'placeholder') {
        hlsUrl = hlsBaseUrl + '/freshwax-main/index.m3u8';
      } else {
        hlsUrl = hlsBaseUrl + '/' + currentStream.streamKey + '/index.m3u8';
      }

      var token = currentUser ? await currentUser.getIdToken() : null;
      if (!token) throw new Error('No auth token');

      var response = await fetch('/api/dj-lobby/broadcast-mode/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ slotId: currentStream.id, mode: mode, hlsUrl: hlsUrl })
      });
      var result = await response.json();
      if (!result.success) throw new Error(result.error);
      console.debug('[Broadcast] Updated via API:', { mode: mode, hlsUrl: hlsUrl });
    } catch (error) {
      console.error('[Broadcast] Failed to update broadcast mode:', error);
    }
  }
}

export function initBroadcastModeToggle() {
  var toggleBtn = document.getElementById('liveOutputToggleBtn');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      if (currentPreviewSource === 'butt' && obsConnected) {
        var newMode = broadcastMode === 'placeholder' ? 'video' : 'placeholder';
        setBroadcastMode(newMode);
      }
    });
  }
}

export function updateButtIndicator(isConnected) {
  var dot = document.getElementById('buttDot');
  var box = document.getElementById('buttIndicator');
  var previewDot = document.getElementById('previewButtDot');
  if (dot) {
    dot.className = 'indicator-dot ' + (isConnected ? 'connected' : 'disconnected');
  }
  if (previewDot) {
    previewDot.className = 'indicator-dot ' + (isConnected ? 'connected' : 'disconnected');
  }
  if (box) {
    box.classList.toggle('connected', isConnected);
    box.classList.toggle('disconnected', !isConnected);
  }
}

// Icecast connection status
export async function checkIcecastStatus() {
  try {
    var response = await fetch('/api/icecast-status/', {
      cache: 'no-store'
    });
    var data = await response.json();

    var wasConnected = icecastStreamConnected;
    icecastStreamConnected = data.streaming === true;

    if (icecastStreamConnected && !wasConnected) {
      updateButtIndicator(true);
      console.debug('[Icecast] Stream detected');
      if (currentPreviewSource !== 'butt' && !currentObsPreviewUrl) {
        console.debug('[Icecast] Auto-switching to BUTT preview');
        setPreviewSource('butt');
      }
    } else if (!icecastStreamConnected && wasConnected) {
      updateButtIndicator(false);
      console.debug('[Icecast] No stream');
    }

    if (data.streaming && data.title && currentPreviewSource === 'butt') {
      var buttStreamTitle = document.getElementById('buttStreamTitle');
      if (buttStreamTitle) {
        buttStreamTitle.textContent = data.title;
      }
    }

    return icecastStreamConnected;
  } catch (e) {
    if (icecastStreamConnected) {
      icecastStreamConnected = false;
      updateButtIndicator(false);
    }
    return false;
  }
}

export function startIcecastCheck() {
  checkIcecastStatus();
  if (!icecastCheckInterval) {
    icecastCheckInterval = setInterval(checkIcecastStatus, 3000);
  }
}

export function stopIcecastCheck() {
  if (icecastCheckInterval) {
    clearInterval(icecastCheckInterval);
    icecastCheckInterval = null;
  }
  if (icecastProbeAudio) {
    icecastProbeAudio.src = '';
    icecastProbeAudio = null;
  }
}

export function setPreviewSource(source) {
  var userInfo = ctx ? ctx.getUserInfo() : null;
  var initBroadcastMeters = ctx ? ctx.initBroadcastMeters : null;
  var broadcastMeterAnimationId = ctx ? ctx.getBroadcastMeterAnimationId() : null;
  var setStreamMode = ctx ? ctx.setStreamMode : null;
  var updateRelayPreview = ctx ? ctx.updateRelayPreview : null;

  currentPreviewSource = source;
  var obsIndicator = document.getElementById('obsIndicator');
  var buttIndicator = document.getElementById('buttIndicator');
  var relayIndicator = document.getElementById('relayIndicator');
  var obsVideoPreview = document.getElementById('obsVideoPreview');
  var buttAudioPreview = document.getElementById('buttAudioPreview');
  var relayPreview = document.getElementById('relayPreview');
  var obsOfflineState = document.getElementById('obsOfflineState');

  if (obsIndicator) obsIndicator.classList.remove('active');
  if (buttIndicator) buttIndicator.classList.remove('active');
  if (relayIndicator) relayIndicator.classList.remove('active');

  if (source === 'obs') {
    if (obsIndicator) obsIndicator.classList.add('active');
    if (buttAudioPreview) buttAudioPreview.classList.add('hidden');
    if (relayPreview) relayPreview.classList.add('hidden');
    if (obsIndicator) obsIndicator.classList.remove('disabled');
    if (buttIndicator) buttIndicator.classList.remove('disabled');
    if (relayIndicator) relayIndicator.classList.add('disabled');
    if (currentObsPreviewUrl && obsHlsPlayer) {
      if (obsVideoPreview) obsVideoPreview.classList.remove('hidden');
      if (obsOfflineState) obsOfflineState.classList.add('hidden');
    } else {
      if (obsVideoPreview) obsVideoPreview.classList.add('hidden');
      if (obsOfflineState) obsOfflineState.classList.remove('hidden');
    }
  } else if (source === 'butt') {
    if (buttIndicator) buttIndicator.classList.add('active');
    if (obsVideoPreview) obsVideoPreview.classList.add('hidden');
    if (obsOfflineState) obsOfflineState.classList.add('hidden');
    if (buttAudioPreview) buttAudioPreview.classList.remove('hidden');
    if (relayPreview) relayPreview.classList.add('hidden');
    if (obsIndicator) obsIndicator.classList.remove('disabled');
    if (buttIndicator) buttIndicator.classList.remove('disabled');
    if (relayIndicator) relayIndicator.classList.add('disabled');
    var buttPreviewDjName = document.getElementById('buttPreviewDjName');
    var buttVinylAvatar = document.getElementById('buttVinylAvatar');
    var buttVinylAvatar2 = document.getElementById('buttVinylAvatar2');
    if (buttPreviewDjName && userInfo) {
      buttPreviewDjName.textContent = userInfo.name || 'DJ';
    }
    if (userInfo && userInfo.avatar) {
      if (buttVinylAvatar) buttVinylAvatar.src = userInfo.avatar;
      if (buttVinylAvatar2) buttVinylAvatar2.src = userInfo.avatar;
    }
    var broadcastAudioPanel = document.getElementById('broadcastAudioPanel');
    if (broadcastAudioPanel) broadcastAudioPanel.classList.remove('hidden');
    if (!broadcastMeterAnimationId && initBroadcastMeters) {
      initBroadcastMeters();
    }
  } else if (source === 'relay') {
    if (relayIndicator) relayIndicator.classList.add('active');
    if (obsVideoPreview) obsVideoPreview.classList.add('hidden');
    if (obsOfflineState) obsOfflineState.classList.add('hidden');
    if (buttAudioPreview) buttAudioPreview.classList.add('hidden');
    if (relayPreview) relayPreview.classList.remove('hidden');
    if (obsIndicator) obsIndicator.classList.add('disabled');
    if (buttIndicator) buttIndicator.classList.add('disabled');
    if (updateRelayPreview) updateRelayPreview();
    if (setStreamMode) setStreamMode('relay');
    var broadcastAudioPanel2 = document.getElementById('broadcastAudioPanel');
    if (broadcastAudioPanel2) broadcastAudioPanel2.classList.remove('hidden');
    if (!broadcastMeterAnimationId && initBroadcastMeters) {
      initBroadcastMeters();
    }
  }
  switchAudioSource(source);
  updateBroadcastModeUI();
}

export function initSourceToggle() {
  var obsIndicator = document.getElementById('obsIndicator');
  var buttIndicator = document.getElementById('buttIndicator');
  var relayIndicator = document.getElementById('relayIndicator');

  if (obsIndicator) {
    obsIndicator.addEventListener('click', function() {
      if (!obsIndicator.classList.contains('disabled')) setPreviewSource('obs');
    });
  }
  if (buttIndicator) {
    buttIndicator.addEventListener('click', function() {
      if (!buttIndicator.classList.contains('disabled')) setPreviewSource('butt');
    });
  }
  if (relayIndicator) {
    relayIndicator.addEventListener('click', function() {
      if (!relayIndicator.classList.contains('disabled')) setPreviewSource('relay');
    });
  }

  var titleInput = document.getElementById('inlineStreamTitle');
  if (titleInput) {
    titleInput.addEventListener('input', function() {
      if (currentPreviewSource === 'butt') {
        var buttStreamTitle = document.getElementById('buttStreamTitle');
        if (buttStreamTitle) {
          buttStreamTitle.textContent = titleInput.value || '';
        }
      }
    });
  }

  var icecastAudio = document.getElementById('icecastAudio');
  if (icecastAudio) {
    icecastAudio.addEventListener('error', function() {
      console.debug('[Icecast] Audio error - stream disconnected');
      icecastConnected = false;
      updateButtIndicator(false);
    });
    icecastAudio.addEventListener('ended', function() {
      console.debug('[Icecast] Audio ended - stream stopped');
      icecastConnected = false;
      updateButtIndicator(false);
    });
    icecastAudio.addEventListener('stalled', function() {
      console.debug('[Icecast] Audio stalled - connection issues');
    });
  }
}

export function switchAudioSource(source) {
  var liveMeterAnimationId = ctx ? ctx.getLiveMeterAnimationId() : null;
  var animateLiveMeters = ctx ? ctx.animateLiveMeters : null;

  buttAudioSource = source;
  console.debug('[Audio] Switching audio source to:', source);

  var icecastAudio = document.getElementById('icecastAudio');

  if (source === 'butt') {
    if (icecastAudio) {
      if (!icecastAudio.src || icecastAudio.paused) {
        console.debug('[Audio] Connecting to Icecast stream...');
        icecastAudio.src = 'https://icecast.freshwax.co.uk/live';
        icecastAudio.load();
      }

      icecastAudio.play().then(function() {
        console.debug('[Audio] Icecast stream playing');
        icecastConnected = true;
        updateButtIndicator(true);
        if (!icecastAudioContext) {
          setupIcecastAnalysers(icecastAudio);
        }
        if (window.startPreviewMeterAnimation) window.startPreviewMeterAnimation();
        if (!liveMeterAnimationId && animateLiveMeters) {
          animateLiveMeters();
        }
      }).catch(function(err) {
        console.debug('[Audio] Icecast play error:', err.message);
        icecastAudio.muted = true;
        icecastAudio.play().then(function() {
          icecastAudio.muted = false;
          icecastConnected = true;
          updateButtIndicator(true);
          if (!icecastAudioContext) {
            setupIcecastAnalysers(icecastAudio);
          }
          if (window.startPreviewMeterAnimation) window.startPreviewMeterAnimation();
          if (!liveMeterAnimationId && animateLiveMeters) {
            animateLiveMeters();
          }
        }).catch(function() {
          console.debug('[Audio] Icecast autoplay blocked - needs user interaction');
          updateButtIndicator(false);
        });
      });
    }
  } else {
    if (icecastAudio && icecastConnected) {
      icecastAudio.pause();
      console.debug('[Audio] Paused Icecast stream');
    }
  }

  var label = document.querySelector('#audioSourceToggle .source-label');
  if (label) {
    label.textContent = broadcastAudioSource.toUpperCase();
  }

  updateAudioSourceIndicator(source, broadcastAudioSource);
}

export function updateAudioSourceIndicator(source, audioMode) {
  var indicator = document.getElementById('audioSourceIndicator');
  var sourceName = indicator ? indicator.querySelector('.source-name') : null;
  if (indicator && sourceName) {
    var mode = audioMode || broadcastAudioSource;
    if (source === 'relay') {
      indicator.classList.add('butt');
      sourceName.textContent = mode === 'live' ? 'RELAY LIVE' : 'RELAY';
    } else if (source === 'butt') {
      indicator.classList.add('butt');
      sourceName.textContent = mode === 'live' ? 'BUTT LIVE' : 'BUTT';
    } else {
      indicator.classList.remove('butt');
      sourceName.textContent = mode === 'live' ? 'OBS LIVE' : 'OBS';
    }
  }
}

export function setupIcecastAnalysers(audioElement) {
  try {
    icecastAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    var source = icecastAudioContext.createMediaElementSource(audioElement);
    var splitter = icecastAudioContext.createChannelSplitter(2);

    icecastAnalyserL = icecastAudioContext.createAnalyser();
    icecastAnalyserR = icecastAudioContext.createAnalyser();
    icecastAnalyserL.fftSize = 256;
    icecastAnalyserR.fftSize = 256;
    icecastAnalyserL.smoothingTimeConstant = 0.5;
    icecastAnalyserR.smoothingTimeConstant = 0.5;

    icecastKWeightedAnalyserL = icecastAudioContext.createAnalyser();
    icecastKWeightedAnalyserR = icecastAudioContext.createAnalyser();
    icecastKWeightedAnalyserL.fftSize = 2048;
    icecastKWeightedAnalyserR.fftSize = 2048;
    icecastKWeightedAnalyserL.smoothingTimeConstant = 0;
    icecastKWeightedAnalyserR.smoothingTimeConstant = 0;

    var highShelfL = icecastAudioContext.createBiquadFilter();
    var highShelfR = icecastAudioContext.createBiquadFilter();
    highShelfL.type = 'highshelf';
    highShelfR.type = 'highshelf';
    highShelfL.frequency.value = 1681.97;
    highShelfR.frequency.value = 1681.97;
    highShelfL.gain.value = 4;
    highShelfR.gain.value = 4;

    var highPassL = icecastAudioContext.createBiquadFilter();
    var highPassR = icecastAudioContext.createBiquadFilter();
    highPassL.type = 'highpass';
    highPassR.type = 'highpass';
    highPassL.frequency.value = 38.14;
    highPassR.frequency.value = 38.14;
    highPassL.Q.value = 0.5;
    highPassR.Q.value = 0.5;

    // Upmix mono to stereo before splitting — copies mono to both L+R
    var upmixNode = icecastAudioContext.createGain();
    upmixNode.channelCount = 2;
    upmixNode.channelCountMode = 'explicit';
    upmixNode.channelInterpretation = 'speakers';
    source.connect(upmixNode);
    upmixNode.connect(splitter);

    splitter.connect(icecastAnalyserL, 0);
    splitter.connect(icecastAnalyserR, 1);

    splitter.connect(highShelfL, 0);
    splitter.connect(highShelfR, 1);
    highShelfL.connect(highPassL);
    highShelfR.connect(highPassR);
    highPassL.connect(icecastKWeightedAnalyserL);
    highPassR.connect(icecastKWeightedAnalyserR);

    icecastGainNode = icecastAudioContext.createGain();
    icecastGainNode.gain.value = 1;

    var limiter = icecastAudioContext.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    source.connect(icecastGainNode);
    icecastGainNode.connect(limiter);
    limiter.connect(icecastAudioContext.destination);

    console.debug('[Audio] Icecast analysers initialized with K-weighting, GainNode, and limiter');
  } catch (e) {
    console.error('[Audio] Icecast analyser setup error:', e);
  }
}

// Relay health indicators
export function updateYoutubeIndicator(status) {
  var dot = document.getElementById('youtubeDot');
  if (dot) {
    dot.className = 'indicator-dot ' + status;
  }
}

export function updateTwitchIndicator(status) {
  var dot = document.getElementById('twitchDot');
  if (dot) {
    dot.className = 'indicator-dot ' + status;
  }
}

export function showRelayIndicators(show) {
  var relayIndicators = document.getElementById('relayIndicators');
  if (relayIndicators) {
    if (show) {
      relayIndicators.classList.remove('hidden');
    } else {
      relayIndicators.classList.add('hidden');
    }
  }
}

export async function checkRelayHealth() {
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  try {
    var response = await fetch('https://stream.freshwax.co.uk:9997/v3/paths/list', {
      signal: AbortSignal.timeout(5000)
    }).catch(function() { return null; });

    if (response && response.ok) {
      var data = await response.json();
      var paths = data.items || [];

      var youtubeRelay = paths.find(function(p) {
        return (p.name && p.name.indexOf('youtube') !== -1) || (p.name && p.name.indexOf('freshwax-main') !== -1);
      });
      updateYoutubeIndicator(youtubeRelay && youtubeRelay.ready ? 'connected' : 'disconnected');

      var twitchRelay = paths.find(function(p) {
        return p.name && p.name.indexOf('twitch') !== -1;
      });
      updateTwitchIndicator(twitchRelay && twitchRelay.ready ? 'connected' : 'disconnected');
    } else {
      updateYoutubeIndicator('connected');
      updateTwitchIndicator('connected');
    }
  } catch (e) {
    console.debug('[RelayHealth] Check failed:', e instanceof Error ? e.message : String(e));
    if (currentStream) {
      updateYoutubeIndicator('connected');
      updateTwitchIndicator('connected');
    }
  }
}

// OBS preview player
export async function checkObsPreview() {
  var currentStreamKey = ctx ? ctx.getCurrentStreamKey() : null;
  if (!currentStreamKey) {
    updateServerIndicator(false);
    updateObsIndicator(false);
    return;
  }

  var baseUrl = window.HLS_BASE_URL || 'https://stream.freshwax.co.uk';
  var previewUrl = baseUrl + '/live/' + currentStreamKey + '/index.m3u8';

  try {
    updateServerIndicator(true);

    var response = await fetch(previewUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      console.debug('[ObsPreview] Stream available at:', previewUrl);
      updateObsIndicator(true);
      obsPreviewFailCount = 0;

      if (currentObsPreviewUrl !== previewUrl) {
        currentObsPreviewUrl = previewUrl;
        initObsPreviewPlayer(previewUrl);
        var obsPanel = document.querySelector('.obs-panel');
        if (obsPanel) obsPanel.classList.add('streaming');
      }
    } else {
      handleObsPreviewFailure('HTTP ' + response.status);
    }
  } catch (e) {
    handleObsPreviewFailure(e instanceof Error ? e.message : String(e));
  }
}

function handleObsPreviewFailure(reason) {
  if (userIsStreaming) {
    updateObsIndicator(false);
    return;
  }

  if (currentObsPreviewUrl && obsHlsPlayer) {
    obsPreviewFailCount++;

    if (obsPreviewFailCount >= OBS_PREVIEW_MAX_FAILS) {
      console.debug('[ObsPreview] Too many failures, destroying player');
      updateObsIndicator(false);
      currentObsPreviewUrl = null;
      obsPreviewFailCount = 0;
      destroyObsPreviewPlayer();
      var obsPanel = document.querySelector('.obs-panel');
      if (obsPanel) obsPanel.classList.remove('streaming');
    }
  } else {
    updateObsIndicator(false);
  }
}

export function initObsPreviewPlayer(url) {
  var videoEl = document.getElementById('obsVideo');
  var offlineState = document.getElementById('obsOfflineState');
  var videoPreview = document.getElementById('obsVideoPreview');
  var broadcastAudioPanel = document.getElementById('broadcastAudioPanel');
  var buttAudioPreview = document.getElementById('buttAudioPreview');

  if (!videoEl) return;

  if (offlineState) offlineState.classList.add('hidden');
  if (currentPreviewSource === 'obs') {
    if (videoPreview) videoPreview.classList.remove('hidden');
    if (buttAudioPreview) buttAudioPreview.classList.add('hidden');
  }
  if (broadcastAudioPanel) broadcastAudioPanel.classList.remove('hidden');

  if (Hls.isSupported()) {
    if (obsHlsPlayer) {
      obsHlsPlayer.destroy();
    }
    obsHlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30
    });
    obsHlsPlayer.loadSource(url);
    obsHlsPlayer.attachMedia(videoEl);
    obsHlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
      videoEl.play().catch(function() {});
    });
    obsHlsPlayer.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        console.debug('[ObsPreview] Fatal HLS error:', data.type, data.details);
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.debug('[ObsPreview] Network error, attempting recovery...');
            obsHlsPlayer.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.debug('[ObsPreview] Media error, attempting recovery...');
            obsHlsPlayer.recoverMediaError();
            break;
          default:
            console.debug('[ObsPreview] Unrecoverable error, destroying player');
            destroyObsPreviewPlayer();
            break;
        }
      }
    });
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url;
    videoEl.play().catch(function() {});
  }
}

export function destroyObsPreviewPlayer() {
  var offlineState = document.getElementById('obsOfflineState');
  var videoPreview = document.getElementById('obsVideoPreview');

  if (obsHlsPlayer) {
    obsHlsPlayer.destroy();
    obsHlsPlayer = null;
  }

  if (videoPreview) videoPreview.classList.add('hidden');

  if (currentPreviewSource === 'obs') {
    if (offlineState) offlineState.classList.remove('hidden');
  } else if (currentPreviewSource === 'butt') {
    if (offlineState) offlineState.classList.add('hidden');
    var buttAudioPreview = document.getElementById('buttAudioPreview');
    if (buttAudioPreview) buttAudioPreview.classList.remove('hidden');
  }
}

export function startObsPreviewCheck() {
  checkObsPreview();
  if (obsPreviewCheckInterval) clearInterval(obsPreviewCheckInterval);
  obsPreviewCheckInterval = setInterval(checkObsPreview, 3000);
}

export function stopObsPreviewCheck() {
  if (obsPreviewCheckInterval) {
    clearInterval(obsPreviewCheckInterval);
    obsPreviewCheckInterval = null;
  }
  destroyObsPreviewPlayer();
}

// Mute button state
export function updateMuteButtonState(player, isMuted) {
  var btn = document.getElementById(player + 'MuteBtn');
  if (!btn) return;

  var mutedIcon = btn.querySelector('.muted-icon');
  var unmutedIcon = btn.querySelector('.unmuted-icon');

  if (isMuted) {
    if (mutedIcon) mutedIcon.classList.remove('hidden');
    if (unmutedIcon) unmutedIcon.classList.add('hidden');
  } else {
    if (mutedIcon) mutedIcon.classList.add('hidden');
    if (unmutedIcon) unmutedIcon.classList.remove('hidden');
  }
}

// Center stats panel
export function updateCenterStats(stats) {
  if (stats.viewers !== undefined) {
    var el = document.getElementById('centerViewers');
    if (el) el.textContent = stats.viewers;
  }
  if (stats.bitrate !== undefined) {
    var el2 = document.getElementById('centerBitrate');
    if (el2) el2.textContent = stats.bitrate;
  }
  if (stats.resolution !== undefined) {
    var el3 = document.getElementById('centerResolution');
    if (el3) el3.textContent = stats.resolution;
  }
  if (stats.fps !== undefined) {
    var el4 = document.getElementById('centerFps');
    if (el4) el4.textContent = stats.fps;
  }
  if (stats.latency !== undefined) {
    var el5 = document.getElementById('centerLatency');
    if (el5) el5.textContent = stats.latency;
  }
  if (stats.uptime !== undefined) {
    var el6 = document.getElementById('centerUptime');
    if (el6) el6.textContent = stats.uptime;
  }
}

// Stream health monitoring
export function updateStreamHealth() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var healthEl = document.getElementById('streamHealth');
  var liveIndicator = document.getElementById('healthLiveIndicator');

  if (!hlsPlayer || !isVideoPlaying) {
    if (healthEl) healthEl.classList.add('hidden');
    if (liveIndicator) liveIndicator.classList.add('hidden');
    return;
  }

  if (healthEl) healthEl.classList.remove('hidden');

  var isMyStream = currentStream && currentUser && currentStream.djId === currentUser.uid;
  if (isMyStream) {
    if (liveIndicator) liveIndicator.classList.remove('hidden');
  } else {
    if (liveIndicator) liveIndicator.classList.add('hidden');
  }

  var bitrateEl = document.getElementById('healthBitrate');
  var qualityEl = document.getElementById('healthQuality');
  var droppedEl = document.getElementById('healthDropped');
  var bufferEl = document.getElementById('healthBuffer');
  var latencyEl = document.getElementById('healthLatency');
  var uptimeEl = document.getElementById('healthUptime');

  var currentLevel = hlsPlayer.levels ? hlsPlayer.levels[hlsPlayer.currentLevel] : null;
  var videoEl = document.getElementById('hlsVideo');

  if (currentLevel) {
    var bitrate = currentLevel.bitrate ? (currentLevel.bitrate / 1000000).toFixed(1) : '--';
    if (bitrateEl) {
      bitrateEl.textContent = bitrate !== '--' ? bitrate + 'Mb' : '--';
      bitrateEl.className = 'stat-value' + (currentLevel.bitrate < 1000000 ? ' warn' : currentLevel.bitrate < 500000 ? ' bad' : '');
    }

    var width = currentLevel.width || (videoEl ? videoEl.videoWidth : 0) || 0;
    var height = currentLevel.height || (videoEl ? videoEl.videoHeight : 0) || 0;
    if (qualityEl) {
      if (height > 0) {
        qualityEl.textContent = width + 'x' + height;
        qualityEl.className = 'stat-value' + (height < 480 ? ' bad' : height < 720 ? ' warn' : '');
      } else {
        qualityEl.textContent = '--';
        qualityEl.className = 'stat-value';
      }
    }
  }

  if (videoEl) {
    var quality = videoEl.getVideoPlaybackQuality ? videoEl.getVideoPlaybackQuality() : null;
    if (quality && droppedEl) {
      var dropped = quality.droppedVideoFrames || 0;
      droppedEl.textContent = dropped.toString();
      droppedEl.className = 'stat-value' + (dropped > 100 ? ' bad' : dropped > 20 ? ' warn' : '');
    }

    if (videoEl.buffered && videoEl.buffered.length > 0 && bufferEl) {
      var buffered = videoEl.buffered.end(videoEl.buffered.length - 1) - videoEl.currentTime;
      bufferEl.textContent = buffered.toFixed(1) + 's';
      bufferEl.className = 'stat-value' + (buffered < 2 ? ' bad' : buffered < 5 ? ' warn' : '');
    }
  }

  if (latencyEl) {
    if (hlsPlayer.latency !== undefined) {
      var latency = hlsPlayer.latency;
      latencyEl.textContent = latency.toFixed(1) + 's';
      latencyEl.className = 'stat-value' + (latency > 15 ? ' bad' : latency > 8 ? ' warn' : '');
    } else if (hlsPlayer.targetLatency !== undefined) {
      latencyEl.textContent = '~' + hlsPlayer.targetLatency.toFixed(0) + 's';
      latencyEl.className = 'stat-value';
    } else {
      latencyEl.textContent = '--';
    }
  }

  var uptimeStr = '--';
  if (streamStartTime) {
    var elapsed = Math.floor((Date.now() - streamStartTime.getTime()) / 1000);
    var hours = Math.floor(elapsed / 3600);
    var mins = Math.floor((elapsed % 3600) / 60);
    var secs = elapsed % 60;
    if (hours > 0) {
      uptimeStr = hours + ':' + mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
    } else {
      uptimeStr = mins + ':' + secs.toString().padStart(2, '0');
    }
    if (uptimeEl) {
      uptimeEl.textContent = uptimeStr;
      uptimeEl.className = 'stat-value';
    }
  } else if (uptimeEl) {
    uptimeEl.textContent = '--';
  }

  var centerStats = {};
  if (currentLevel) {
    var br = currentLevel.bitrate ? (currentLevel.bitrate / 1000000).toFixed(1) : '--';
    centerStats.bitrate = br !== '--' ? br + 'Mb' : '--';
    var w = currentLevel.width || (videoEl ? videoEl.videoWidth : 0) || 0;
    var h = currentLevel.height || (videoEl ? videoEl.videoHeight : 0) || 0;
    centerStats.resolution = h > 0 ? h + 'p' : '--';
    var fps = currentLevel.frameRate || (currentLevel.attrs ? currentLevel.attrs['FRAME-RATE'] : null) || '--';
    centerStats.fps = fps !== '--' ? Math.round(fps) : '--';
  }
  if (hlsPlayer.latency !== undefined) {
    centerStats.latency = hlsPlayer.latency.toFixed(1) + 's';
  } else if (hlsPlayer.targetLatency !== undefined) {
    centerStats.latency = '~' + hlsPlayer.targetLatency.toFixed(0) + 's';
  }
  centerStats.uptime = uptimeStr;
  updateCenterStats(centerStats);
}

export function startHealthMonitoring() {
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(updateStreamHealth, 5000);
}

export function stopHealthMonitoring() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  var healthEl = document.getElementById('streamHealth');
  if (healthEl) healthEl.classList.add('hidden');
}

// Twitch settings
export function saveTwitchSettings() {
  var usernameEl = document.getElementById('twitchUsername');
  var streamKeyEl = document.getElementById('twitchStreamKey');
  var saveBtn = document.getElementById('saveTwitchBtn');
  var username = usernameEl ? (usernameEl.value ? usernameEl.value.trim() : '') : '';
  var streamKey = streamKeyEl ? (streamKeyEl.value ? streamKeyEl.value.trim() : '') : '';

  if (!username && !streamKey) {
    sessionStorage.removeItem('freshwax_twitch_username');
    sessionStorage.removeItem('freshwax_twitch_key');
  } else {
    if (username) sessionStorage.setItem('freshwax_twitch_username', username);
    if (streamKey) sessionStorage.setItem('freshwax_twitch_key', streamKey);
  }

  if (saveBtn) {
    var originalText = saveBtn.textContent;
    saveBtn.textContent = 'Saved!';
    saveBtn.style.background = '#16a34a';
    setTimeout(function() {
      saveBtn.textContent = originalText;
      saveBtn.style.background = '';
    }, 1500);
  }
}

export function loadTwitchSettings() {
  var username = sessionStorage.getItem('freshwax_twitch_username');
  var streamKey = sessionStorage.getItem('freshwax_twitch_key');

  if (username) {
    var usernameInput = document.getElementById('twitchUsername');
    if (usernameInput) usernameInput.value = username;
  }
  if (streamKey) {
    var keyInput = document.getElementById('twitchStreamKey');
    if (keyInput) keyInput.value = streamKey;
  }
}

// Copy output URL
export function copyOutputUrlToClipboard() {
  var outputUrlEl = document.getElementById('outputUrl');
  var copyBtn = document.getElementById('copyOutputUrl');
  var outputUrl = outputUrlEl ? (outputUrlEl.textContent ? outputUrlEl.textContent.trim() : '') : '';

  if (!outputUrl) return;

  navigator.clipboard.writeText(outputUrl).then(function() {
    if (copyBtn) {
      var originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(function() {
        copyBtn.textContent = originalText;
      }, 1500);
    }
  }).catch(function() {
    var textArea = document.createElement('textarea');
    textArea.value = outputUrl;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    if (copyBtn) {
      copyBtn.textContent = 'Copied!';
      setTimeout(function() {
        copyBtn.textContent = 'Copy';
      }, 1500);
    }
  });
}

// Stream fade transitions
export function updateTimeRemaining() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var hasSameDjNextSlot = ctx ? ctx.hasSameDjNextSlot : null;
  var calculateContinuousEndTime = ctx ? ctx.calculateContinuousEndTime : null;
  var isInEventMode = ctx ? ctx.isInEventMode : null;
  var log = ctx ? ctx.log : function() {};

  var timeLeft = document.getElementById('timeLeft');
  var headerTimeLeft = document.getElementById('headerTimeLeft');
  var headerTimeRemaining = document.getElementById('headerTimeRemaining');

  if (!streamEndTime) {
    if (timeLeft) timeLeft.textContent = '--:--:--';
    if (headerTimeLeft) headerTimeLeft.textContent = '--:--:--';
    if (headerTimeRemaining) headerTimeRemaining.classList.add('hidden');
    return;
  }

  var now = new Date();
  var diff = streamEndTime - now;

  if (diff <= 0) {
    if (currentStream && hasSameDjNextSlot && hasSameDjNextSlot(currentStream.djId, streamEndTime)) {
      log('[Stream] Same DJ has next slot, extending without transition');
      var newEndTime = calculateContinuousEndTime ? calculateContinuousEndTime(currentStream.djId, streamEndTime) : streamEndTime;
      if (newEndTime > streamEndTime) {
        streamEndTime = newEndTime;
        isFadingOut = false;
        var playerWrapper = document.querySelector('.preview-player');
        if (playerWrapper) {
          playerWrapper.classList.remove('fading-out', 'faded-out');
        }
        return;
      }
    }

    if (timeLeft) {
      timeLeft.textContent = '00:00:00.0';
      timeLeft.style.color = '#dc2626';
    }
    if (headerTimeLeft) {
      headerTimeLeft.textContent = '00:00:00.0';
      headerTimeLeft.classList.add('urgent');
    }
    if (currentStream && (currentStream.djId === (currentUser ? currentUser.uid : null) || currentStream.isRelay)) {
      console.debug('[Stream DEBUG] Skipping fade - own stream or relay, djId:', currentStream.djId, 'isRelay:', currentStream.isRelay);
      return;
    }
    triggerStreamFadeOut();
    return;
  }

  var hours = Math.floor(diff / 3600000);
  var mins = Math.floor((diff % 3600000) / 60000);
  var secs = Math.floor((diff % 60000) / 1000);
  var tenths = Math.floor((diff % 1000) / 100);
  var timeStr = hours.toString().padStart(2, '0') + ':' + mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0') + '.' + tenths;

  if (timeLeft) timeLeft.textContent = timeStr;
  if (headerTimeLeft) {
    headerTimeLeft.textContent = timeStr;
    if (hours === 0 && mins < 5) {
      headerTimeLeft.classList.add('urgent');
    } else {
      headerTimeLeft.classList.remove('urgent');
    }
  }
  if (headerTimeRemaining) headerTimeRemaining.classList.remove('hidden');

  var sameDjContinues = currentStream && hasSameDjNextSlot && hasSameDjNextSlot(currentStream.djId, streamEndTime);
  var inEventMode = isInEventMode ? isInEventMode() : false;

  var isOwnStreamOrRelay = currentStream && (currentStream.djId === (currentUser ? currentUser.uid : null) || currentStream.isRelay);
  var skipTransitions = sameDjContinues || inEventMode || isOwnStreamOrRelay;

  if (diff <= 10000 && diff > 0 && !skipTransitions) {
    startGradualFadeOut(diff / 10000);
  }

  if (mins < 5) {
    if (timeLeft) timeLeft.style.color = '#dc2626';
  } else {
    if (timeLeft) timeLeft.style.color = '#fff';
  }
}

export function startGradualFadeOut(progress) {
  console.debug('[Stream DEBUG] startGradualFadeOut called! progress:', progress);
  var videoEl = document.getElementById('hlsVideo');
  var audioEl = document.getElementById('audioElement');
  var playerWrapper = document.querySelector('.preview-player');

  var opacity = Math.max(0, progress);
  var volume = Math.max(0, progress);

  if (videoEl) {
    videoEl.style.opacity = opacity;
    videoEl.volume = volume;
  }
  if (audioEl) {
    audioEl.volume = volume;
  }
  if (playerWrapper && !isFadingOut) {
    playerWrapper.classList.add('fading-out');
  }
}

export function triggerStreamFadeOut() {
  console.debug('[Stream DEBUG] triggerStreamFadeOut called!');
  if (isFadingOut) return;
  isFadingOut = true;

  var videoEl = document.getElementById('hlsVideo');
  var audioEl = document.getElementById('audioElement');
  var playerWrapper = document.querySelector('.preview-player');

  if (playerWrapper) {
    playerWrapper.classList.add('faded-out');
  }
  if (videoEl) {
    videoEl.style.opacity = '0';
    videoEl.volume = 0;
  }
  if (audioEl) {
    audioEl.volume = 0;
  }
}

export function triggerStreamFadeIn() {
  isFadingOut = false;
  var videoEl = document.getElementById('hlsVideo');
  var audioEl = document.getElementById('audioElement');
  var playerWrapper = document.querySelector('.preview-player');

  if (playerWrapper) {
    playerWrapper.classList.remove('fading-out', 'faded-out');
    playerWrapper.classList.add('fading-in');
  }
  if (videoEl) {
    videoEl.style.opacity = '0';
    videoEl.style.transition = 'opacity 2s ease-in';
    setTimeout(function() {
      videoEl.style.opacity = '1';
      videoEl.volume = 1;
    }, 100);
  }
  if (audioEl) {
    audioEl.volume = 0;
    var vol = 0;
    var fadeInInterval = setInterval(function() {
      vol += 0.05;
      if (vol >= 1) {
        vol = 1;
        clearInterval(fadeInInterval);
      }
      audioEl.volume = vol;
    }, 100);
  }

  setTimeout(function() {
    if (playerWrapper) playerWrapper.classList.remove('fading-in');
  }, 2000);
}

// Cleanup all intervals
export function cleanupAllIntervals() {
  stopHealthMonitoring();
  stopIcecastCheck();
  stopObsPreviewCheck();
}
