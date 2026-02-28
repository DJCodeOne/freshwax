// public/dj-lobby/mobile-broadcast.js
// Mobile WHIP broadcast logic for DJ Lobby — adapted from go-live.astro
// Plain JS only (no TypeScript syntax — this is loaded via <script is:inline type="module">)

import { whipConnect, whipDisconnect, whipReplaceTrack, whipGetStats, whipIsConnected } from '/whip-client.js?v=2';

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
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };

  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
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

  // Step 2: Connect WHIP
  try {
    await whipConnect(whipData.whipUrl, mediaStream, {
      onStateChange: function(state) {
        if (state === 'failed') {
          endStream(token, true);
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

  // Step 3: Wait for ICE
  await new Promise(function(resolve) { setTimeout(resolve, 1500); });

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
    await whipDisconnect().catch(function() {});
    throw new Error('Could not reach go-live API. Check your connection.');
  }

  if (!goLiveResp.ok) {
    var goLiveErr = {};
    try { goLiveErr = await goLiveResp.json(); } catch (e) { /* ignore */ }
    await whipDisconnect().catch(function() {});
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
  acquireWakeLock();
  startTimer(timerEl);
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

  // Disconnect WHIP
  try { await whipDisconnect(); } catch (e) { /* ignore */ }

  // Call endStream API
  try {
    if (currentSlotId && token) {
      var djId = ctx && ctx.getCurrentUser ? ctx.getCurrentUser().uid : null;
      await fetch('/api/livestream/slots/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          action: 'endStream',
          slotId: currentSlotId,
          djId: djId
        })
      });
    }
  } catch (e) { /* best effort */ }

  // Stop media tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach(function(t) { t.stop(); });
    mediaStream = null;
  }

  // Clean up
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
  if (isLive && currentSlotId) {
    var djId = ctx && ctx.getCurrentUser ? ctx.getCurrentUser().uid : null;
    try {
      navigator.sendBeacon('/api/livestream/slots/', JSON.stringify({
        action: 'endStream',
        slotId: currentSlotId,
        djId: djId
      }));
    } catch (e) { /* best effort */ }
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(function(t) { t.stop(); });
    mediaStream = null;
  }

  releaseWakeLock();
  stopTimer();
  stopAudioMeter();
  isLive = false;
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
