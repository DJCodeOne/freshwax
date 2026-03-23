// public/live/hls-player.js
// Live page — HLS.js setup, audio/video playback, recording, audio analyzer

var _hlsLoadPromise = null;
var hlsPlayer = null;
var hlsAbortController = null;
var hlsListenerSignal = null;
var globalAudioContext = null;
var globalAnalyserLeft = null;
var globalAnalyserRight = null;
var globalAnimationId = null;
var globalMediaSource = null;
var globalMediaElement = null;
var isPlaying = false;

// Recording state
var recordingStartTime = null;
var recordingInterval = null;
var isRecording = false;
var recordingAudioContext = null;
var recordingSourceNode = null;
var recordingScriptNode = null;
var recordingLeftChannel = [];
var recordingRightChannel = [];
var recordingSampleRate = 44100;
var lameEncoder = null;

// Callbacks set by orchestrator
var _onStopLiveStream = null;
var _onCheckLiveStatus = null;
var _escapeHtml = null;

export function initHlsPlayer(deps) {
  if (deps.onStopLiveStream) _onStopLiveStream = deps.onStopLiveStream;
  if (deps.onCheckLiveStatus) _onCheckLiveStatus = deps.onCheckLiveStatus;
  if (deps.escapeHtml) _escapeHtml = deps.escapeHtml;
}

export function getIsPlaying() {
  return isPlaying;
}

export function setIsPlaying(val) {
  isPlaying = val;
}

export function getHlsPlayer() {
  return hlsPlayer;
}

export function loadHlsLibrary() {
  if (window.Hls) return Promise.resolve();
  if (_hlsLoadPromise) return _hlsLoadPromise;
  _hlsLoadPromise = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.12/dist/hls.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function() { resolve(); };
    s.onerror = function() {
      _hlsLoadPromise = null;
      reject(new Error('Failed to load HLS.js'));
    };
    document.head.appendChild(s);
  });
  return _hlsLoadPromise;
}

export function normalizeHlsUrl(url) {
  if (!url) return url;
  var match = url.match(/\/live\/[^\/]+\/index\.m3u8$/);
  return match ? 'https://stream.freshwax.co.uk' + match[0] : url;
}

export function initGlobalAudioAnalyzer(mediaEl) {
  if (!globalAudioContext || !globalMediaSource || globalMediaElement !== mediaEl) {
    if (globalAudioContext && globalMediaElement !== mediaEl) {
      try { globalAudioContext.close(); } catch (e) {
        console.warn('[Audio] Error closing old context:', e);
      }
      globalAudioContext = null;
      globalMediaSource = null;
      globalAnalyserLeft = null;
      globalAnalyserRight = null;
    }
    try {
      globalAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      globalMediaSource = globalAudioContext.createMediaElementSource(mediaEl);
      globalMediaElement = mediaEl;
      var splitter = globalAudioContext.createChannelSplitter(2);
      globalAnalyserLeft = globalAudioContext.createAnalyser();
      globalAnalyserRight = globalAudioContext.createAnalyser();
      globalAnalyserLeft.fftSize = 256;
      globalAnalyserRight.fftSize = 256;
      globalAnalyserLeft.smoothingTimeConstant = 0.5;
      globalAnalyserRight.smoothingTimeConstant = 0.5;
      var gain = globalAudioContext.createGain();
      gain.channelCount = 2;
      gain.channelCountMode = 'explicit';
      gain.channelInterpretation = 'speakers';
      globalMediaSource.connect(gain);
      gain.connect(splitter);
      splitter.connect(globalAnalyserLeft, 0);
      splitter.connect(globalAnalyserRight, 1);
      globalMediaSource.connect(globalAudioContext.destination);
    } catch (e) {
      console.error('[Audio] Analyzer error:', e);
    }
  }
}

function updateGlobalMeters() {
  if (!globalAnalyserLeft || !globalAnalyserRight) {
    globalAnimationId = requestAnimationFrame(updateGlobalMeters);
    return;
  }
  var leftLeds = document.querySelectorAll('#leftMeter .led');
  var rightLeds = document.querySelectorAll('#rightMeter .led');
  if (leftLeds.length === 0 || rightLeds.length === 0) {
    globalAnimationId = requestAnimationFrame(updateGlobalMeters);
    return;
  }
  var leftData = new Uint8Array(globalAnalyserLeft.frequencyBinCount);
  var rightData = new Uint8Array(globalAnalyserRight.frequencyBinCount);
  globalAnalyserLeft.getByteFrequencyData(leftData);
  globalAnalyserRight.getByteFrequencyData(rightData);
  var leftSum = 0;
  var rightSum = 0;
  for (var i = 0; i < leftData.length; i++) {
    leftSum += leftData[i] * leftData[i];
    rightSum += rightData[i] * rightData[i];
  }
  var leftRms = Math.sqrt(leftSum / leftData.length);
  var rightRms = Math.sqrt(rightSum / rightData.length);
  if (rightRms === 0 && leftRms > 0) rightRms = leftRms;
  var leftLevel = Math.min(14, Math.floor((leftRms / 255) * 18));
  var rightLevel = Math.min(14, Math.floor((rightRms / 255) * 18));
  leftLeds.forEach(function(led, idx) { led.classList.toggle('active', idx < leftLevel); });
  rightLeds.forEach(function(led, idx) { led.classList.toggle('active', idx < rightLevel); });
  globalAnimationId = requestAnimationFrame(updateGlobalMeters);
}

export function stopGlobalMeters() {
  if (globalAnimationId) {
    cancelAnimationFrame(globalAnimationId);
    globalAnimationId = null;
  }
  document.querySelectorAll('.led-strip .led').forEach(function(led) {
    led.classList.remove('active');
  });
}

export function startGlobalMeters() {
  if (!globalAnimationId) updateGlobalMeters();
}

export function showLiveMeters() {
  var metersWrapper = document.getElementById('stereoMetersWrapper');
  var waveWrapper = document.getElementById('soundWaveWrapper');
  if (metersWrapper) metersWrapper.classList.remove('hidden');
  if (waveWrapper) waveWrapper.classList.add('hidden');
  startGlobalMeters();
}

export function hideLiveMeters() {
  var metersWrapper = document.getElementById('stereoMetersWrapper');
  if (metersWrapper) metersWrapper.classList.add('hidden');
  stopGlobalMeters();
}

export function showPlaylistWave() {
  var metersWrapper = document.getElementById('stereoMetersWrapper');
  var waveWrapper = document.getElementById('soundWaveWrapper');
  if (metersWrapper) metersWrapper.classList.add('hidden');
  stopGlobalMeters();
  if (waveWrapper) {
    waveWrapper.classList.remove('hidden');
    waveWrapper.classList.remove('paused');
  }
}

export function pausePlaylistWave() {
  var waveWrapper = document.getElementById('soundWaveWrapper');
  if (waveWrapper) waveWrapper.classList.add('paused');
}

export function resumePlaylistWave() {
  var waveWrapper = document.getElementById('soundWaveWrapper');
  if (waveWrapper) waveWrapper.classList.remove('paused');
}

export function hidePlaylistWave() {
  var waveWrapper = document.getElementById('soundWaveWrapper');
  if (waveWrapper) waveWrapper.classList.add('hidden');
}

export function updateMiniPlayer(playing) {
  var miniPlayIcon = document.getElementById('miniPlayIcon');
  var miniPauseIcon = document.getElementById('miniPauseIcon');
  var miniPlayBtn = document.getElementById('miniPlayBtn');
  if (playing) {
    if (miniPlayIcon) miniPlayIcon.classList.add('hidden');
    if (miniPauseIcon) miniPauseIcon.classList.remove('hidden');
    if (miniPlayBtn) miniPlayBtn.classList.add('playing');
  } else {
    if (miniPlayIcon) miniPlayIcon.classList.remove('hidden');
    if (miniPauseIcon) miniPauseIcon.classList.add('hidden');
    if (miniPlayBtn) miniPlayBtn.classList.remove('playing');
  }
}

export function setupMediaSession(streamData) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: streamData?.title || 'Live Stream',
    artist: streamData?.djName || 'Fresh Wax',
    album: 'Fresh Wax Live',
    artwork: [
      { src: streamData?.djAvatar || '/logo.webp', sizes: '96x96', type: 'image/png' },
      { src: streamData?.djAvatar || '/logo.webp', sizes: '128x128', type: 'image/png' },
      { src: streamData?.djAvatar || '/logo.webp', sizes: '192x192', type: 'image/png' },
      { src: streamData?.djAvatar || '/logo.webp', sizes: '256x256', type: 'image/png' },
      { src: streamData?.djAvatar || '/logo.webp', sizes: '384x384', type: 'image/png' },
      { src: streamData?.djAvatar || '/logo.webp', sizes: '512x512', type: 'image/png' }
    ]
  });
  navigator.mediaSession.setActionHandler('play', function() {
    var btn = document.getElementById('playBtn');
    if (btn && !btn.classList.contains('playing')) btn.click();
  });
  navigator.mediaSession.setActionHandler('pause', function() {
    var btn = document.getElementById('playBtn');
    if (btn && btn.classList.contains('playing')) btn.click();
  });
  navigator.mediaSession.setActionHandler('stop', function() {
    var btn = document.getElementById('playBtn');
    if (btn && btn.classList.contains('playing')) btn.click();
  });
}

export function showReconnecting() {
  var videoPlayer = document.getElementById('videoPlayer');
  if (!videoPlayer) return;
  if (videoPlayer.querySelector('.reconnect-overlay')) return;
  var overlay = document.createElement('div');
  overlay.className = 'reconnect-overlay';
  overlay.innerHTML = '\n    <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.8); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem;">\n      <div style="width: 40px; height: 40px; border: 3px solid #333; border-top-color: #dc2626; border-radius: 50%; animation: spin 1s linear infinite;"></div>\n      <span style="color: #fff; font-size: 0.9rem;">Reconnecting...</span>\n    </div>\n  ';
  videoPlayer.appendChild(overlay);
  setTimeout(function() { overlay.remove(); }, 5000);
}

export function showStreamError(msg) {
  var videoPlayer = document.getElementById('videoPlayer');
  if (!videoPlayer) return;
  videoPlayer.innerHTML = '\n    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #1a1a1a; color: #fff; padding: 2rem; text-align: center;">\n      <div style="font-size: 3rem; margin-bottom: 1rem;">📡</div>\n      <h3 style="margin: 0 0 0.5rem 0; font-size: 1.125rem;">Connecting to Stream...</h3>\n      <p style="color: #888; margin: 0; font-size: 0.875rem;">' + msg + '</p>\n      <button onclick="location.reload()" style="margin-top: 1rem; padding: 0.75rem 1.5rem; background: #dc2626; border: none; border-radius: 8px; color: #fff; cursor: pointer; font-size: 1rem; -webkit-tap-highlight-color: transparent;">\n        Retry\n      </button>\n    </div>\n  ';
}

export function showTapToPlay() {
  var videoPlayer = document.getElementById('videoPlayer');
  if (!videoPlayer) return;
  var overlay = document.createElement('div');
  overlay.id = 'tapToPlayOverlay';
  overlay.style.cssText = '\n    position: absolute;\n    inset: 0;\n    background: rgba(0,0,0,0.8);\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    justify-content: center;\n    gap: 1rem;\n    z-index: 10;\n    cursor: pointer;\n  ';
  overlay.innerHTML = '\n    <div style="width: 80px; height: 80px; border-radius: 50%; background: #dc2626; display: flex; align-items: center; justify-content: center;">\n      <svg viewBox="0 0 24 24" fill="#fff" width="40" height="40"><path d="M8 5v14l11-7z"/></svg>\n    </div>\n    <span style="color: #fff; font-size: 1.125rem;">Tap to Play</span>\n  ';
  overlay.onclick = function() {
    var vid = document.getElementById('hlsVideoElement');
    if (vid) {
      vid.play().then(function() { overlay.remove(); }).catch(console.error);
    }
  };
  videoPlayer.appendChild(overlay);
}

export async function setupHlsPlayer(streamData, deps) {
  var shouldAutoplay = deps.shouldAutoplay;
  var wasLiveStreamPlaying = deps.wasLiveStreamPlaying;
  var rememberAutoplay = deps.rememberAutoplay;
  var setLiveStreamPlaying = deps.setLiveStreamPlaying;

  await loadHlsLibrary().catch(function(err) {
    console.warn('[HLS] Failed to load library:', err);
  });

  var audioPlayer = document.getElementById('audioPlayer');
  var videoPlayer = document.getElementById('videoPlayer');
  if (audioPlayer) audioPlayer.classList.add('hidden');
  if (videoPlayer) videoPlayer.classList.remove('hidden');

  var video = document.getElementById('hlsVideoElement');
  var twitchEmbed = document.getElementById('twitchEmbed');
  var playlistPlayer = document.getElementById('playlistPlayer');
  var playlistOverlay = document.getElementById('playlistLoadingOverlay');

  if (video) video.classList.remove('hidden');
  if (twitchEmbed) twitchEmbed.classList.add('hidden');
  if (playlistPlayer) { playlistPlayer.classList.add('hidden'); playlistPlayer.style.display = 'none'; }
  if (playlistOverlay) playlistOverlay.classList.add('hidden');

  var hlsUrl = normalizeHlsUrl(
    streamData.hlsUrl || streamData.videoStreamUrl || streamData.audioStreamUrl || (streamData.relaySource && streamData.relaySource.url)
  );

  if (!hlsUrl) {
    console.error('No HLS URL available');
    setupAudioPlayer(streamData, deps);
    return;
  }

  function onPause() { stopGlobalMeters(); }

  if (video) {
    if (hlsAbortController) hlsAbortController.abort();
    hlsAbortController = new AbortController();
    hlsListenerSignal = { signal: hlsAbortController.signal };

    video.addEventListener('play', function() {
      initGlobalAudioAnalyzer(video);
      if (globalAudioContext && globalAudioContext.state === 'suspended') globalAudioContext.resume();
      startGlobalMeters();
      var initOverlay = document.getElementById('initializingOverlay');
      if (initOverlay) { initOverlay.classList.add('fade-out', 'hidden'); initOverlay.style.display = 'none'; }
      var playIcon = document.getElementById('playIcon');
      var pauseIcon = document.getElementById('pauseIcon');
      var playBtn = document.getElementById('playBtn');
      if (playIcon) playIcon.classList.add('hidden');
      if (pauseIcon) pauseIcon.classList.remove('hidden');
      if (playBtn) playBtn.classList.add('playing');
    }, hlsListenerSignal);

    video.addEventListener('pause', onPause, hlsListenerSignal);
    video.addEventListener('ended', onPause, hlsListenerSignal);
    video.addEventListener('error', function(e) {
      console.error('[HLS] Video element error:', e);
      console.error('[HLS] Video error code:', video.error && video.error.code);
      console.error('[HLS] Video error message:', video.error && video.error.message);
    }, hlsListenerSignal);

    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');

    if (video.canPlayType('application/vnd.apple.mpegurl') === 'probably') {
      // Native HLS support (Safari)
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', function() {
        (async function() {
          try {
            if (shouldAutoplay()) {
              await video.play();
              isPlaying = true;
              var pi = document.getElementById('playIcon');
              var pa = document.getElementById('pauseIcon');
              var pb = document.getElementById('playBtn');
              if (pi) pi.classList.add('hidden');
              if (pa) pa.classList.remove('hidden');
              if (pb) pb.classList.add('playing');
              return;
            }
            video.muted = true;
            await video.play();
            isPlaying = true;
            var pi2 = document.getElementById('playIcon');
            var pa2 = document.getElementById('pauseIcon');
            var pb2 = document.getElementById('playBtn');
            if (pi2) pi2.classList.add('hidden');
            if (pa2) pa2.classList.remove('hidden');
            if (pb2) pb2.classList.add('playing');
            setTimeout(function() { video.muted = false; }, 100);
          } catch (e) {
            // Autoplay blocked
          }
        })();
      });
    } else if (window.Hls && Hls.isSupported()) {
      if (hlsPlayer) hlsPlayer.destroy();
      hlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: window.isMobileDevice ? 20 : 30,
        maxMaxBufferLength: window.isMobileDevice ? 45 : 90,
        maxBufferSize: 30000000,
        maxBufferHole: 0.5,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
        liveBackBufferLength: 30,
        initialLiveManifestSize: 1,
        startPosition: -1,
        startFragPrefetch: true,
        testBandwidth: false,
        highBufferWatchdogPeriod: 1,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 5,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 200,
        fragLoadingMaxRetryTimeout: 20000,
        manifestLoadingMaxRetry: 5,
        manifestLoadingRetryDelay: 200,
        manifestLoadingMaxRetryTimeout: 15000,
        levelLoadingMaxRetry: 5,
        levelLoadingRetryDelay: 200,
        levelLoadingMaxRetryTimeout: 15000
      });
      hlsPlayer.loadSource(hlsUrl);
      hlsPlayer.attachMedia(video);

      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
        (async function() {
          var wasPlaying = wasLiveStreamPlaying();
          try {
            if (wasPlaying && shouldAutoplay()) {
              video.muted = false;
              await video.play();
              isPlaying = true;
              setLiveStreamPlaying(true);
            } else {
              video.muted = true;
              await video.play();
              isPlaying = true;
              try {
                video.muted = false;
                setLiveStreamPlaying(true);
              } catch (e) {}
            }
            var pi = document.getElementById('playIcon');
            var pa = document.getElementById('pauseIcon');
            var pb = document.getElementById('playBtn');
            if (pi) pi.classList.add('hidden');
            if (pa) pa.classList.remove('hidden');
            if (pb) pb.classList.add('playing');
            rememberAutoplay();
            initGlobalAudioAnalyzer(video);
            startGlobalMeters();
          } catch (e) {
            var pi2 = document.getElementById('playIcon');
            var pa2 = document.getElementById('pauseIcon');
            var pb2 = document.getElementById('playBtn');
            if (pi2) pi2.classList.remove('hidden');
            if (pa2) pa2.classList.add('hidden');
            if (pb2) pb2.classList.remove('playing');
          }
        })();
      });

      var retryCount = 0;
      var maxRetries = 5;
      hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
        if (data.fatal) {
          console.error('[HLS] Fatal error:', data.type, data.details);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              retryCount++;
              if (retryCount <= maxRetries) {
                hlsPlayer.startLoad();
                var delay = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);
                setTimeout(function() {
                  if (!isPlaying) {
                    showReconnecting();
                    hlsPlayer.loadSource(hlsUrl);
                  }
                }, delay);
              } else {
                hlsPlayer.destroy();
                hlsPlayer = null;
                if (_onStopLiveStream) _onStopLiveStream();
                if (_onCheckLiveStatus) _onCheckLiveStatus();
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hlsPlayer.recoverMediaError();
              break;
            default:
              console.error('[HLS] Fatal error, cannot recover');
              hlsPlayer.destroy();
              hlsPlayer = null;
              if (_onStopLiveStream) _onStopLiveStream();
              if (_onCheckLiveStatus) _onCheckLiveStatus();
          }
        }
      });
    } else {
      console.error('[HLS] Not supported - Hls exists:', !!window.Hls, 'isSupported:', !!window.Hls && Hls.isSupported());
      showStreamError('Your browser does not support HLS playback.');
    }

    setupMediaSession(streamData);
    setupRecording(video);

    var playBtn = document.getElementById('playBtn');
    var volumeSlider = document.getElementById('volumeSlider');
    if (playBtn) playBtn.disabled = false;
    if (volumeSlider) {
      if (video) video.volume = volumeSlider.value / 100;
      volumeSlider.oninput = function(e) {
        var val = e.target.value;
        if (video) video.volume = val / 100;
        if (window.playlistManager) window.playlistManager.setVolume(parseInt(val));
      };
    }

    video.addEventListener('play', function() {
      isPlaying = true;
      var pi = document.getElementById('playIcon');
      var pa = document.getElementById('pauseIcon');
      if (pi) pi.classList.add('hidden');
      if (pa) pa.classList.remove('hidden');
      if (playBtn) playBtn.classList.add('playing');
      updateMiniPlayer(true);
      window.emojiAnimationsEnabled = true;
      startGlobalMeters();
    }, hlsListenerSignal);

    video.addEventListener('pause', function() {
      isPlaying = false;
      var pi = document.getElementById('playIcon');
      var pa = document.getElementById('pauseIcon');
      if (pi) pi.classList.remove('hidden');
      if (pa) pa.classList.add('hidden');
      if (playBtn) playBtn.classList.remove('playing');
      updateMiniPlayer(false);
      stopGlobalMeters();
    }, hlsListenerSignal);
  }
}

export function setupTwitchPlayer(streamData) {
  var audioPlayer = document.getElementById('audioPlayer');
  var videoPlayer = document.getElementById('videoPlayer');
  if (audioPlayer) audioPlayer.classList.add('hidden');
  if (videoPlayer) videoPlayer.classList.remove('hidden');

  var video = document.getElementById('hlsVideoElement');
  var twitchEmbed = document.getElementById('twitchEmbed');
  if (video) video.classList.add('hidden');
  if (twitchEmbed) twitchEmbed.classList.remove('hidden');

  var playlistPlayer = document.getElementById('playlistPlayer');
  if (playlistPlayer) { playlistPlayer.classList.add('hidden'); playlistPlayer.style.display = 'none'; }
  var playlistOverlay = document.getElementById('playlistLoadingOverlay');
  if (playlistOverlay) playlistOverlay.classList.add('hidden');

  var hostname = window.location.hostname;
  if (twitchEmbed) {
    twitchEmbed.innerHTML = '\n      <iframe\n        src="https://player.twitch.tv/?channel=' + encodeURIComponent(streamData.twitchChannel) + '&parent=' + encodeURIComponent(hostname) + '&muted=false"\n        allowfullscreen\n        frameborder="0"\n        style="width: 100%; height: 100%;"\n      ></iframe>\n    ';
  }
}

export async function setupAudioPlayer(streamData, deps) {
  var shouldAutoplay = deps.shouldAutoplay;
  var wasLiveStreamPlaying = deps.wasLiveStreamPlaying;
  var setLiveStreamPlaying = deps.setLiveStreamPlaying;

  await loadHlsLibrary().catch(function(err) {
    console.warn('[HLS] Failed to load for audio:', err);
  });

  var audioPlayerEl = document.getElementById('audioPlayer');
  var videoPlayerEl = document.getElementById('videoPlayer');
  if (audioPlayerEl) audioPlayerEl.classList.remove('hidden');
  if (videoPlayerEl) videoPlayerEl.classList.add('hidden');

  var playlistOverlay = document.getElementById('playlistLoadingOverlay');
  if (playlistOverlay) playlistOverlay.classList.add('hidden');

  var audioEl = document.getElementById('audioElement');
  var playBtn = document.getElementById('playBtn');
  var volumeSlider = document.getElementById('volumeSlider');

  if (streamData.audioStreamUrl && audioEl) {
    var streamUrl = streamData.audioStreamUrl;
    var isHlsStream = streamUrl.includes('.m3u8');

    var tryAutoplay = async function() {
      var wasPlaying = wasLiveStreamPlaying();
      try {
        if (wasPlaying && shouldAutoplay()) {
          audioEl.muted = false;
          await audioEl.play();
          isPlaying = true;
          setLiveStreamPlaying(true);
        } else {
          audioEl.muted = true;
          await audioEl.play();
          isPlaying = true;
          try {
            audioEl.muted = false;
            setLiveStreamPlaying(true);
          } catch (e) {}
        }
        var initOverlay = document.getElementById('initializingOverlay');
        if (initOverlay && !initOverlay.classList.contains('hidden')) {
          initOverlay.classList.add('fade-out');
          setTimeout(function() { initOverlay.classList.add('hidden'); }, 500);
        }
        var pi = document.getElementById('playIcon');
        var pa = document.getElementById('pauseIcon');
        if (pi) pi.classList.add('hidden');
        if (pa) pa.classList.remove('hidden');
        if (playBtn) playBtn.classList.add('playing');
        initGlobalAudioAnalyzer(audioEl);
        startGlobalMeters();
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Audio] Autoplay blocked:', e.name);
        var pi2 = document.getElementById('playIcon');
        var pa2 = document.getElementById('pauseIcon');
        if (pi2) pi2.classList.remove('hidden');
        if (pa2) pa2.classList.add('hidden');
        if (playBtn) playBtn.classList.remove('playing');
      }
    };

    if (isHlsStream && typeof Hls !== 'undefined' && Hls.isSupported()) {
      if (window.audioHlsPlayer) window.audioHlsPlayer.destroy();
      window.audioHlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 20,
        maxMaxBufferLength: 45,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
        liveBackBufferLength: 30,
        liveDurationInfinity: true,
        startPosition: -1,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 200
      });
      window.audioHlsPlayer.loadSource(streamUrl);
      window.audioHlsPlayer.attachMedia(audioEl);
      window.audioHlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
        tryAutoplay();
      });
      window.audioHlsPlayer.on(Hls.Events.ERROR, function(event, data) {
        console.error('[Audio] HLS error:', data.type, data.details);
        if (data.fatal) {
          console.error('[Audio] Fatal HLS error, trying recovery');
          window.audioHlsPlayer.recoverMediaError();
        }
      });
    } else {
      audioEl.src = streamUrl;
      audioEl.load();
    }

    audioEl.onerror = function(e) {
      console.error('[Audio] ERROR:', audioEl.error && audioEl.error.code, audioEl.error && audioEl.error.message);
    };
    audioEl.onplaying = function() {
      var initOverlay = document.getElementById('initializingOverlay');
      if (initOverlay) { initOverlay.classList.add('fade-out', 'hidden'); initOverlay.style.display = 'none'; }
      var pi = document.getElementById('playIcon');
      var pa = document.getElementById('pauseIcon');
      var pb = document.getElementById('playBtn');
      if (pi) pi.classList.add('hidden');
      if (pa) pa.classList.remove('hidden');
      if (pb) pb.classList.add('playing');
    };
    if (!audioEl.paused && audioEl.readyState >= 2 && audioEl.onplaying) audioEl.onplaying();
    if (audioEl.readyState >= 3) {
      tryAutoplay();
    } else {
      audioEl.addEventListener('canplay', function() { tryAutoplay(); }, { once: true });
    }
  }

  if (audioEl && volumeSlider) audioEl.volume = volumeSlider.value / 100;
  if (playBtn) playBtn.disabled = false;
  if (volumeSlider) {
    volumeSlider.oninput = function(e) {
      var val = e.target.value;
      if (audioEl) audioEl.volume = val / 100;
      if (window.playlistManager) window.playlistManager.setVolume(parseInt(val));
    };
  }
  setupMediaSession(streamData);
  setupRecording(audioEl);
}

export function setupRecording(mediaEl) {
  var recordBtn = document.getElementById('recordBtn');
  if (!recordBtn) return;
  if (window.userIsPro !== true) {
    recordBtn.disabled = true;
    recordBtn.classList.add('pro-locked');
    recordBtn.title = 'Upgrade to Pro to record livestreams';
    recordBtn.onclick = function(e) {
      e.preventDefault();
      if (confirm('Recording is a Pro feature.\n\nUpgrade to Fresh Wax Pro to record livestreams and download them as audio files.\n\nWould you like to upgrade now?')) {
        window.location.href = '/account/dashboard#upgrade';
      }
    };
    return;
  }
  recordBtn.disabled = false;
  recordBtn.classList.remove('pro-locked');
  recordBtn.title = 'Record live stream';
  recordBtn.onclick = function() {
    if (isRecording) stopRecordingFn();
    else startRecordingFn(mediaEl);
  };
}

async function loadLameEncoder() {
  if (lameEncoder) return lameEncoder;
  return new Promise(function(resolve) {
    if (window.lamejs) {
      lameEncoder = window.lamejs;
      resolve(lameEncoder);
      return;
    }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    s.onload = function() {
      lameEncoder = window.lamejs;
      resolve(lameEncoder);
    };
    s.onerror = function() {
      console.error('[Recording] Failed to load lame encoder');
      resolve(null);
    };
    document.head.appendChild(s);
  });
}

async function startRecordingFn(mediaEl) {
  var recordBtn = document.getElementById('recordBtn');
  var recordDuration = document.getElementById('recordDuration');
  if (!mediaEl) { console.error('[Recording] No media element'); return; }

  await loadLameEncoder();
  if (!lameEncoder) { alert('Failed to load MP3 encoder. Recording not available.'); return; }

  try {
    var stream;
    if (mediaEl.captureStream) { stream = mediaEl.captureStream(); }
    else if (mediaEl.mozCaptureStream) { stream = mediaEl.mozCaptureStream(); }
    else { alert('Recording not supported in your browser.'); return; }

    var audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) { alert('No audio track available.'); return; }

    var audioStream = new MediaStream(audioTracks);
    recordingAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    recordingSampleRate = recordingAudioContext.sampleRate;
    recordingSourceNode = recordingAudioContext.createMediaStreamSource(audioStream);

    var bufferSize = 4096;
    recordingScriptNode = recordingAudioContext.createScriptProcessor(bufferSize, 2, 2);
    recordingLeftChannel = [];
    recordingRightChannel = [];
    recordingScriptNode.onaudioprocess = function(e) {
      if (!isRecording) return;
      var left = new Float32Array(e.inputBuffer.getChannelData(0));
      var right = new Float32Array(e.inputBuffer.getChannelData(1));
      recordingLeftChannel.push(left);
      recordingRightChannel.push(right);
    };
    recordingSourceNode.connect(recordingScriptNode);
    recordingScriptNode.connect(recordingAudioContext.destination);
    isRecording = true;
    recordingStartTime = Date.now();
    if (recordBtn) recordBtn.classList.add('recording');
    var recordText = recordBtn && recordBtn.querySelector('.record-text');
    if (recordText) recordText.textContent = 'STOP';
    if (recordDuration) recordDuration.classList.remove('hidden');
    recordingInterval = setInterval(function() {
      var elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      var mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      var secs = (elapsed % 60).toString().padStart(2, '0');
      if (recordDuration) recordDuration.textContent = mins + ':' + secs;
    }, 1000);
  } catch (e) {
    console.error('[Recording] Failed:', e);
    alert('Failed to start recording.');
  }
}

function stopRecordingFn() {
  var recordBtn = document.getElementById('recordBtn');
  var recordDuration = document.getElementById('recordDuration');
  var wasRecording = isRecording;
  isRecording = false;
  if (recordingInterval) { clearInterval(recordingInterval); recordingInterval = null; }
  if (recordingScriptNode) { recordingScriptNode.disconnect(); recordingScriptNode = null; }
  if (recordingSourceNode) { recordingSourceNode.disconnect(); recordingSourceNode = null; }
  if (recordingAudioContext) { recordingAudioContext.close(); recordingAudioContext = null; }
  if (recordBtn) recordBtn.classList.remove('recording');
  var recordText = recordBtn && recordBtn.querySelector('.record-text');
  if (recordText) recordText.textContent = 'REC';
  if (recordDuration) { recordDuration.classList.add('hidden'); recordDuration.textContent = '00:00'; }
  if (wasRecording && recordingLeftChannel.length > 0) encodeAndDownloadMp3();
}

export function getIsRecording() { return isRecording; }
export function stopRecording() { stopRecordingFn(); }

function floatTo16BitPCM(input) {
  var output = new Int16Array(input.length);
  for (var i = 0; i < input.length; i++) {
    var s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? 32768 * s : 32767 * s;
  }
  return output;
}

function encodeAndDownloadMp3() {
  if (!lameEncoder || recordingLeftChannel.length === 0) {
    recordingLeftChannel = [];
    recordingRightChannel = [];
    return;
  }
  try {
    var totalLength = recordingLeftChannel.reduce(function(acc, buf) { return acc + buf.length; }, 0);
    var leftFull = new Float32Array(totalLength);
    var rightFull = new Float32Array(totalLength);
    var offset = 0;
    for (var i = 0; i < recordingLeftChannel.length; i++) {
      leftFull.set(recordingLeftChannel[i], offset);
      rightFull.set(recordingRightChannel[i], offset);
      offset += recordingLeftChannel[i].length;
    }
    var leftPcm = floatTo16BitPCM(leftFull);
    var rightPcm = floatTo16BitPCM(rightFull);
    var encoder = new lameEncoder.Mp3Encoder(2, recordingSampleRate, 192);
    var chunks = [];
    var sampleBlockSize = 1152;
    for (var j = 0; j < leftPcm.length; j += sampleBlockSize) {
      var leftChunk = leftPcm.subarray(j, j + sampleBlockSize);
      var rightChunk = rightPcm.subarray(j, j + sampleBlockSize);
      var mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
      if (mp3buf.length > 0) chunks.push(mp3buf);
    }
    var flushed = encoder.flush();
    if (flushed.length > 0) chunks.push(flushed);
    var blob = new Blob(chunks, { type: 'audio/mp3' });
    var djName = (document.getElementById('djName') && document.getElementById('djName').textContent) || 'DJ';
    var streamTitle = (document.getElementById('streamTitle') && document.getElementById('streamTitle').textContent) || 'Live';
    var dateStr = new Date().toISOString().split('T')[0];
    var sanitize = function(str) {
      return str.replace(/[^a-zA-Z0-9\s\-\_]/g, '').trim().replace(/\s+/g, '_');
    };
    var filename = 'FreshWax_' + sanitize(djName) + '_' + sanitize(streamTitle) + '_' + dateStr + '.mp3';
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  } catch (e) {
    console.error('[Recording] Encoding failed:', e);
    alert('Failed to encode recording. Please try again.');
  }
  recordingLeftChannel = [];
  recordingRightChannel = [];
}

export function destroyHlsPlayer() {
  if (hlsPlayer) {
    try { hlsPlayer.destroy(); } catch (e) {
      console.error('[LiveStream] Error destroying HLS player:', e);
    }
    hlsPlayer = null;
  }
  if (window.audioHlsPlayer) {
    try { window.audioHlsPlayer.destroy(); } catch (e) {
      console.error('[LiveStream] Error destroying audio HLS player:', e);
    }
    window.audioHlsPlayer = null;
  }
}

export function cleanupHlsAbort() {
  if (hlsAbortController) {
    hlsAbortController.abort();
    hlsAbortController = null;
  }
}

export function getGlobalAudioContext() {
  return globalAudioContext;
}
