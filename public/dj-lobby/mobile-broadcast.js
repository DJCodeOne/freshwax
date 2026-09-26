// public/dj-lobby/mobile-broadcast.js
// Mobile WHIP broadcast logic for DJ Lobby — adapted from go-live.astro
// Plain JS only (no TypeScript syntax — this is loaded via <script is:inline type="module">)

import { whipConnect, whipDisconnect, whipReplaceTrack, whipGetStats, whipIsConnected } from '/whip-client.js?v=3';

var ctx = null;

// State
var mediaStream = null;
var audioContext = null;
var analyser = null;
var animFrameId = null;
var wakeLock = null;
var isLive = false;
var facingMode = 'user';
var timerInterval = null;
var liveStartTime = null;
var currentSlotId = null;
var currentStreamKey = null;
var previousVideoBytes = 0;
var previousStatsTime = 0;
var reconnectTimeout = null;
var reconnectAttempts = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var RECONNECT_BACKOFF = [5000, 10000, 20000, 40000, 60000]; // exponential backoff
var heartbeatInterval = null;
var cachedToken = null;
var reconnecting = false;
var missedHeartbeats = 0;

export function init(context) {
  ctx = context;
}

/**
 * Start the camera and attach to a video element
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(videoEl) {
  var constraints = {
    video: {
      facingMode: facingMode,
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    // DJ sets are music: voice-call noise suppression and auto gain mangle
    // it (smeared highs, pumping levels). Echo cancellation stays on — with
    // nothing playing back it's transparent, and it stops a feedback loop if
    // the page ever plays the stream's own audio.
    audio: {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false
    }
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (camErr) {
    // Provide specific error messages based on error type
    if (camErr && camErr.name === 'NotAllowedError') {
      throw new Error('Camera/microphone permission denied. Please allow access in your browser settings and try again.');
    } else if (camErr && camErr.name === 'NotFoundError') {
      throw new Error('No camera or microphone found. Please connect a device and try again.');
    } else if (camErr && camErr.name === 'NotReadableError') {
      throw new Error('Camera or microphone is in use by another app. Please close other apps using the camera and try again.');
    } else if (camErr && camErr.name === 'OverconstrainedError') {
      throw new Error('Camera does not support the requested resolution. Please try a different camera.');
    } else {
      throw new Error('Could not access camera/microphone: ' + (camErr && camErr.message ? camErr.message : String(camErr)));
    }
  }
  videoEl.srcObject = mediaStream;
  // Mirror front camera preview (CSS only — doesn't affect stream output)
  videoEl.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';

  startAudioMeter();
  return mediaStream;
}

/**
 * Flip between front and back camera
 * @param {HTMLVideoElement} videoEl
 */
export async function flipCamera(videoEl) {
  if (!mediaStream) return;

  facingMode = facingMode === 'user' ? 'environment' : 'user';

  try {
    var newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    var newVideoTrack = newStream.getVideoTracks()[0];
    var oldVideoTrack = mediaStream.getVideoTracks()[0];

    if (isLive) {
      await whipReplaceTrack(oldVideoTrack, newVideoTrack);
    }

    mediaStream.removeTrack(oldVideoTrack);
    oldVideoTrack.stop();
    mediaStream.addTrack(newVideoTrack);
    videoEl.srcObject = mediaStream;
    videoEl.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
  } catch (err) {
    // Revert facing mode on failure
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    throw err;
  }
}

/**
 * Toggle microphone on/off
 * @returns {boolean} true if now muted
 */
export function toggleMic() {
  if (!mediaStream) return false;
  var audioTracks = mediaStream.getAudioTracks();
  audioTracks.forEach(function(t) { t.enabled = !t.enabled; });
  return audioTracks.length > 0 && !audioTracks[0].enabled;
}

/**
 * Toggle camera on/off
 * @returns {boolean} true if camera is now off
 */
export function toggleCamera() {
  if (!mediaStream) return false;
  var videoTracks = mediaStream.getVideoTracks();
  videoTracks.forEach(function(t) { t.enabled = !t.enabled; });
  return videoTracks.length > 0 && !videoTracks[0].enabled;
}

/**
 * Go live via WHIP
 * @param {string} token - Auth token
 * @param {string} slotId - Booked slot ID
 * @param {string} streamKey - Stream key
 * @param {string} djId - DJ user ID
 * @param {string} djName - DJ display name
 * @param {string} djAvatar - DJ avatar URL
 * @param {HTMLElement} timerEl - Element to update with timer text
 * @param {function} [onStats] - Optional stats callback
 */
export async function goLive(token, slotId, streamKey, djId, djName, djAvatar, timerEl, onStats) {
  if (!mediaStream) throw new Error('Camera not started');

  currentSlotId = slotId;
  currentStreamKey = streamKey;

  // Step 1: Get WHIP URL
  var whipResp;
  try {
    whipResp = await fetch('/api/livestream/whip-url/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        slotId: slotId,
        djId: djId,
        streamKey: streamKey
      })
    });
  } catch (fetchErr) {
    throw new Error('Could not reach server. Check your connection.');
  }

  if (!whipResp.ok) {
    var whipErr = {};
    try { whipErr = await whipResp.json(); } catch (e) { /* ignore */ }
    throw new Error(whipErr.error || 'Failed to get WHIP URL (HTTP ' + whipResp.status + ')');
  }

  var whipData = await whipResp.json();

  if (!whipData.whipUrl) {
    throw new Error('Server returned empty WHIP URL');
  }

  // While this device's camera is broadcasting (connecting or live), the
  // lobby's OBS preview must not find and play our own stream: it would come
  // out of the speaker a few seconds late, straight into the live mic.
  setBrowserBroadcasting(true);
  try {
  // Step 2: Connect WHIP
  try {
    await whipConnect(whipData.whipUrl, mediaStream, {
      onStateChange: function(state) {
        if (state === 'failed' || state === 'ice-failed') {
          // Prompt user to retry instead of auto-ending
          handleConnectionLost(token, whipData.whipUrl, timerEl, onStats);
        } else if (state === 'disconnected' || state === 'ice-disconnected') {
          // Temporary disconnect — wait for recovery before prompting
          if (!reconnectTimeout) {
            reconnectTimeout = setTimeout(function() {
              reconnectTimeout = null;
              // If still disconnected after 5s, prompt user
              if (isLive && !whipIsConnected()) {
                handleConnectionLost(token, whipData.whipUrl, timerEl, onStats);
              }
            }, 5000);
          }
        } else if (state === 'connected' || state === 'ice-connected') {
          // Connection recovered — clear any pending reconnect timer
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
          }
        }
      },
      onStats: function(stats) {
        if (onStats) onStats(stats);
      },
      onError: function() {
        // Handled by onStateChange
      }
    });
  } catch (whipErr) {
    var msg = whipErr && whipErr.message ? whipErr.message : String(whipErr);
    throw new Error('Stream server unreachable: ' + msg);
  }

  // Step 3: Wait until media is actually flowing (ICE + DTLS connected). A
  // fixed 1.5 s used to mark the slot live even when the connection never
  // came up — e.g. on a network that blocks UDP — leaving a dead stream.
  var connected = await waitForMediaConnection(15000);
  if (!connected) {
    await whipDisconnect().catch(function() { /* non-critical: WHIP cleanup */ });
    throw new Error('Could not connect to the stream server. This network may be blocking live video — try mobile data or another Wi-Fi, or stream with OBS.');
  }

  // Step 4: Call go_live API
  var goLiveResp;
  try {
    goLiveResp = await fetch('/api/livestream/slots/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        action: 'go_live',
        djId: djId,
        djName: djName,
        djAvatar: djAvatar || '/place-holder.webp',
        streamKey: streamKey,
        title: djName + ' - Live',
        genre: 'Jungle / D&B',
        broadcastMode: 'browser'
      })
    });
  } catch (fetchErr) {
    await whipDisconnect().catch(function() { /* non-critical: WHIP cleanup on go-live failure */ });
    throw new Error('Could not reach go-live API. Check your connection.');
  }

  if (!goLiveResp.ok) {
    var goLiveErr = {};
    try { goLiveErr = await goLiveResp.json(); } catch (e) { /* ignore */ }
    await whipDisconnect().catch(function() { /* non-critical: WHIP cleanup on go-live error response */ });
    throw new Error(goLiveErr.error || 'Failed to go live');
  }

  var goLiveData = await goLiveResp.json();
  // API returns { slot: { id: ... } } — extract the actual live slot ID
  if (goLiveData.slot && goLiveData.slot.id) {
    currentSlotId = goLiveData.slot.id;
  } else if (goLiveData.slotId) {
    currentSlotId = goLiveData.slotId;
  }

  // Success
  isLive = true;
  cachedToken = token;
  acquireWakeLock();
  startTimer(timerEl);
  startHeartbeat(token);
  } catch (goLiveErr) {
    setBrowserBroadcasting(false);
    throw goLiveErr;
  }
}

/** Tell the lobby (video-player.js OBS preview) that this device is broadcasting. */
function setBrowserBroadcasting(on) {
  try { window.__fwBrowserBroadcasting = !!on; } catch (e) { /* no window */ }
}

/**
 * End the stream
 * @param {string} token - Auth token
 * @param {boolean} [force] - Skip confirmation
 * @returns {Promise<boolean>} true if ended
 */
export async function endStream(token, force) {
  if (!isLive && !force) return false;

  isLive = false;
  stopHeartbeat();

  // Disconnect WHIP
  try { await whipDisconnect(); } catch (e) { /* ignore */ }

  // Call endStream API — retry once with fresh token if 401
  var ended = false;
  if (currentSlotId) {
    var djId = ctx && ctx.getCurrentUser ? ctx.getCurrentUser().uid : null;
    var attempts = 0;
    var authToken = token;

    while (attempts < 2 && !ended) {
      attempts++;
      try {
        var headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
        var resp = await fetch('/api/livestream/slots/', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            action: 'endStream',
            slotId: currentSlotId,
            djId: djId
          })
        });
        if (resp.ok) {
          ended = true;
        } else if (resp.status === 401 && attempts === 1 && ctx && ctx.getCurrentUser) {
          // Token expired — try refreshing
          try {
            var user = ctx.getCurrentUser();
            if (user && user.getIdToken) {
              authToken = await user.getIdToken(true);
            }
          } catch (refreshErr) {
            /* token refresh failed */
          }
        } else {
          /* endStream API returned error */
          break;
        }
      } catch (fetchErr) {
        /* endStream API failed */
        break;
      }
    }
  }

  // Stop media tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach(function(t) { t.stop(); });
    mediaStream = null;
  }

  // Clean up
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  reconnectAttempts = 0;
  reconnecting = false;
  setBrowserBroadcasting(false);
  releaseWakeLock();
  stopTimer();
  stopAudioMeter();

  currentSlotId = null;
  currentStreamKey = null;

  return true;
}

/**
 * Cleanup handler for pagehide/unload — uses sendBeacon
 */
export function cleanup() {
  stopHeartbeat();

  if (isLive && currentSlotId) {
    var djId = ctx && ctx.getCurrentUser ? ctx.getCurrentUser().uid : null;
    try {
      // Use Blob with JSON content-type so the POST handler accepts it
      // Include idToken in body for auth (sendBeacon can't set Authorization header)
      var payload = {
        action: 'endStream',
        slotId: currentSlotId,
        djId: djId
      };
      if (cachedToken) payload.idToken = cachedToken;
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/api/livestream/slots/', blob);
    } catch (e) { /* best effort */ }
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(function(t) { t.stop(); });
    mediaStream = null;
  }

  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  reconnectAttempts = 0;
  reconnecting = false;
  setBrowserBroadcasting(false);
  releaseWakeLock();
  stopTimer();
  stopAudioMeter();
  isLive = false;
}

/**
 * Start heartbeat — sends signal every 30s to prove DJ is still streaming
 * @param {string} token - Auth token
 */
function startHeartbeat(token) {
  stopHeartbeat();
  missedHeartbeats = 0;
  heartbeatInterval = setInterval(function() {
    if (!isLive || !currentSlotId) { stopHeartbeat(); return; }
    var authToken = token;
    // Try to get fresh token if ctx is available
    if (ctx && ctx.getCurrentUser) {
      var user = ctx.getCurrentUser();
      if (user && user.getIdToken) {
        user.getIdToken().then(function(t) { authToken = t; }).catch(function() { /* non-critical: token refresh for heartbeat */ });
      }
    }
    var headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    fetch('/api/livestream/slots/', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: 'heartbeat', slotId: currentSlotId })
    }).then(function(resp) {
      // 404 = the site no longer has this slot live (booked time over, ended
      // by an admin or on another device). Two in a row → stop sending, so the
      // phone doesn't keep "LIVE" into the void.
      if (resp.status === 404) {
        missedHeartbeats++;
        if (missedHeartbeats >= 2) stopForServerEnd();
      } else if (resp.ok) {
        missedHeartbeats = 0;
      }
    }).catch(function() { /* network blip — the WHIP reconnect logic handles real drops */ });
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

/**
 * Re-acquire wake lock (call on visibilitychange → visible)
 */
export function reacquireWakeLock() {
  if (isLive && !wakeLock) {
    acquireWakeLock();
  }
}

/**
 * @returns {boolean}
 */
export function getIsLive() {
  return isLive;
}

/**
 * @returns {MediaStream|null}
 */
export function getMediaStream() {
  return mediaStream;
}

/**
 * Stop broadcasting because the site ended this slot (its booked time is over,
 * an admin ended it, or it was ended from another device). No-op when not live.
 * The lobby listens for 'fw:mobile-stream-stopped' to reset its UI.
 * @returns {Promise<boolean>} true if a live stream was stopped
 */
export function stopForServerEnd() {
  if (!isLive) return Promise.resolve(false);
  return endStream(cachedToken, true).then(function() {
    try { window.dispatchEvent(new CustomEvent('fw:mobile-stream-stopped', { detail: { reason: 'server' } })); } catch (e) { /* old browsers */ }
    return true;
  });
}

/**
 * Handle a lost connection: reconnect automatically with backoff, up to
 * MAX_RECONNECT_ATTEMPTS, then end the stream. No blocking confirm(): it froze
 * the page mid-set, and a browser auto-dismisses it in a background tab —
 * which ended the stream. The DJ can still end it with the End button.
 * @param {string} token
 * @param {string} whipUrl
 * @param {HTMLElement} timerEl
 * @param {function} [onStats]
 */
function handleConnectionLost(token, whipUrl, timerEl, onStats) {
  // One failure fires both 'failed' and 'ice-failed' — reconnect once.
  if (!isLive || reconnecting) return;

  reconnectAttempts++;

  // Too many retries — force end stream
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    (window.showToast?window.showToast('Connection lost after ' + MAX_RECONNECT_ATTEMPTS + ' attempts. Ending stream.',"error"):alert('Connection lost after ' + MAX_RECONNECT_ATTEMPTS + ' attempts. Ending stream.'));
    endStream(token, true).then(function() {
      try { window.dispatchEvent(new CustomEvent('fw:mobile-stream-stopped', { detail: { reason: 'connection' } })); } catch (e) { /* old browsers */ }
    });
    return;
  }

  var backoffMs = RECONNECT_BACKOFF[Math.min(reconnectAttempts - 1, RECONNECT_BACKOFF.length - 1)];
  if (!mediaStream) { endStream(token, true); return; }

  reconnecting = true;
  if (window.showToast) window.showToast('Connection lost. Reconnecting (attempt ' + reconnectAttempts + ' of ' + MAX_RECONNECT_ATTEMPTS + ')…', 'info');

  function retryLater() {
    setTimeout(function() { handleConnectionLost(token, whipUrl, timerEl, onStats); }, backoffMs);
  }

  whipDisconnect().catch(function() { /* non-critical: WHIP cleanup before reconnect */ }).then(function() {
    return whipConnect(whipUrl, mediaStream, {
      onStateChange: function(state) {
        if (state === 'failed' || state === 'ice-failed') {
          retryLater();
        } else if (state === 'disconnected' || state === 'ice-disconnected') {
          if (!reconnectTimeout) {
            reconnectTimeout = setTimeout(function() {
              reconnectTimeout = null;
              if (isLive && !whipIsConnected()) {
                handleConnectionLost(token, whipUrl, timerEl, onStats);
              }
            }, backoffMs);
          }
        } else if (state === 'connected' || state === 'ice-connected') {
          // Successfully reconnected — reset counter
          reconnectAttempts = 0;
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
          }
        }
      },
      onStats: function(stats) {
        if (onStats) onStats(stats);
      },
      onError: function() {}
    });
  }).then(function() {
    reconnecting = false;
  }).catch(function() {
    // Couldn't reach the server at all (offline, or it refused) — try again
    // after the backoff until the attempts run out.
    reconnecting = false;
    retryLater();
  });
}

/**
 * Resolve true once the peer connection is up (media flowing), false after
 * timeoutMs.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForMediaConnection(timeoutMs) {
  return new Promise(function(resolve) {
    var deadline = Date.now() + timeoutMs;
    (function check() {
      if (whipIsConnected()) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(check, 250);
    })();
  });
}

// ---- Internal helpers ----

function acquireWakeLock() {
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then(function(lock) {
      wakeLock = lock;
      lock.addEventListener('release', function() { wakeLock = null; });
    }).catch(function() { /* not critical */ });
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }
}

function startTimer(timerEl) {
  liveStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(function() {
    if (!liveStartTime || !timerEl) return;
    timerEl.textContent = formatDuration(Date.now() - liveStartTime);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  liveStartTime = null;
}

function formatDuration(ms) {
  var totalSec = Math.floor(ms / 1000);
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function startAudioMeter() {
  if (!mediaStream) return;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);

    var meterEl = document.getElementById('mobileAudioMeter');
    if (!meterEl) return;
    var bars = meterEl.querySelectorAll('.mobile-meter-bar');
    if (!bars.length) return;
    var dataArray = new Uint8Array(analyser.frequencyBinCount);

    function updateMeter() {
      if (!analyser) return;
      analyser.getByteFrequencyData(dataArray);
      for (var i = 0; i < bars.length; i++) {
        var value = dataArray[i * 2] || 0;
        var height = Math.max(3, (value / 255) * 20);
        bars[i].style.height = height + 'px';
      }
      animFrameId = requestAnimationFrame(updateMeter);
    }
    updateMeter();
  } catch (e) {
    // Audio meter not critical
  }
}

function stopAudioMeter() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (audioContext) {
    try { audioContext.close(); } catch (e) { /* ignore */ }
    audioContext = null;
  }
  analyser = null;
}
