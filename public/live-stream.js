// public/live-stream.js
// Thin orchestrator — imports focused modules for the /live page
// Modules: hls-player, pusher-events, chat-handler, ui-controls

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

import {
  initHlsPlayer, getIsPlaying, setIsPlaying, getHlsPlayer, loadHlsLibrary, normalizeHlsUrl,
  initGlobalAudioAnalyzer, stopGlobalMeters, startGlobalMeters,
  showLiveMeters, hideLiveMeters, showPlaylistWave, pausePlaylistWave, resumePlaylistWave, hidePlaylistWave,
  updateMiniPlayer, setupMediaSession, showReconnecting, showStreamError, showTapToPlay,
  setupHlsPlayer, setupTwitchPlayer, setupAudioPlayer, setupRecording,
  destroyHlsPlayer, cleanupHlsAbort, getGlobalAudioContext,
  getIsRecording, stopRecording
} from '/live/hls-player.js';

import {
  getPusherConfig, loadPusherScript, setupLiveStatusPusher
} from '/live/pusher-events.js';

import {
  initChatHandler, setChatCurrentUser, setChatCurrentStream,
  getChatChannel, getChatMessages, resetChatMessages,
  setupChat, sendGiphyMessage, setChatEnabled, setReactionButtonsEnabled
} from '/live/chat-handler.js';

import {
  initUiControls, detectMobileDevice, setupVolumeSlider,
  setupMobileFeatures, cleanupUiControls
} from '/live/ui-controls.js';

// --- Firebase setup ---
var firebaseConfig = window.FIREBASE_CONFIG || {
  apiKey: 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  authDomain: 'freshwax-store.firebaseapp.com',
  projectId: 'freshwax-store',
  storageBucket: 'freshwax-store.firebasestorage.app',
  messagingSenderId: '675435782973',
  appId: '1:675435782973:web:e8459c2ec4a5f6d683db54'
};
var app = getApps().length ? getApp() : initializeApp(firebaseConfig);
var auth = getAuth(app);

// --- Shared state ---
var wakeLock = null;
var currentUser = null;
var currentStream = null;
var playlistManager = null;
var streamEndedAt = null;
var wasLiveStreamActive = false;
var streamDetectedThisSession = false;
var liveStatusPollInterval = null;
var slowPollInterval = null;
var viewerSessionId = null;
var heartbeatInterval = null;
var durationTimerInterval = null;
var lastSyncTime = 0;
var activeUsers = new Map();
var heartbeatOnlineUsers = [];

window.liveStreamState = { currentUser: null, currentStream: null };

// --- Autoplay storage keys ---
var AUTOPLAY_KEY = 'freshwax_autoplay';
var LIVE_PLAYING_KEY = 'freshwax_live_playing';

function shouldAutoplay() { return localStorage.getItem(AUTOPLAY_KEY) === 'true'; }
function rememberAutoplay() { localStorage.setItem(AUTOPLAY_KEY, 'true'); }
function setLiveStreamPlaying(val) {
  if (val) sessionStorage.setItem(LIVE_PLAYING_KEY, 'true');
  else sessionStorage.removeItem(LIVE_PLAYING_KEY);
}
function wasLiveStreamPlaying() { return sessionStorage.getItem(LIVE_PLAYING_KEY) === 'true'; }

// --- Utility ---
function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function escapeJsString(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c');
}

// --- Wake Lock ---
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function() { wakeLock = null; });
    } catch (e) {}
  }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(function() {}); wakeLock = null; }
}

// --- Active user tracking ---
function trackActiveUser(msg) {
  if (!msg.userId || msg.userId === 'freshwax-bot') return;
  activeUsers.set(msg.userId, {
    id: msg.userId, name: msg.userName || 'User', avatar: msg.userAvatar || null, lastSeen: Date.now()
  });
  var cu = window.liveStreamState && window.liveStreamState.currentUser;
  if (cu && !activeUsers.has(cu.uid)) {
    activeUsers.set(cu.uid, {
      id: cu.uid, name: cu.displayName || (cu.email && cu.email.split('@')[0]) || 'User',
      avatar: cu.photoURL || null, lastSeen: Date.now()
    });
  }
  if (window.updateOnlineUsers) window.updateOnlineUsers(window.getOnlineViewers());
}

window.emojiAnimationsEnabled = false;

window.getOnlineViewers = function() {
  var merged = new Map();
  for (var i = 0; i < heartbeatOnlineUsers.length; i++) {
    var u = heartbeatOnlineUsers[i];
    if (u.id && u.id !== 'freshwax-bot') merged.set(u.id, { id: u.id, name: u.name || 'User', avatar: u.avatar || null });
  }
  var cutoff = Date.now() - 300000;
  activeUsers.forEach(function(val, key) {
    if (val.lastSeen > cutoff && key !== 'freshwax-bot' && !merged.has(key)) merged.set(key, { id: val.id, name: val.name, avatar: val.avatar });
  });
  return Array.from(merged.values());
};

window.setHeartbeatOnlineUsers = function(users) { heartbeatOnlineUsers = users || []; };

// --- Initialize module deps ---
loadPusherScript();

initHlsPlayer({
  onStopLiveStream: function() { stopLiveStream(); },
  onCheckLiveStatus: function() { checkLiveStatus(); },
  escapeHtml: escapeHtml
});

initChatHandler({
  escapeHtml: escapeHtml,
  escapeJsString: escapeJsString,
  trackActiveUser: trackActiveUser
});

initUiControls({
  onVisibilityReturn: function() {
    if (window.isLiveStreamActive) requestWakeLock();
    lastSyncTime = Date.now();
    if (currentStream) refreshViewerCount(currentStream.id);
    syncPlayButtonWithPlaylist();
  }
});

// --- Playlist handling ---
function handlePlaylistUpdate(e) {
  var queue = e.detail.queue;
  var playing = e.detail.isPlaying;
  var videoPlayer = document.getElementById('videoPlayer');
  var hlsVideo = document.getElementById('hlsVideoElement');
  var playlistPlayer = document.getElementById('playlistPlayer');
  var offlineOverlay = document.getElementById('offlineOverlay');
  var audioPlayer = document.getElementById('audioPlayer');
  var playBtn = document.getElementById('playBtn');
  var playIcon = document.getElementById('playIcon');
  var pauseIcon = document.getElementById('pauseIcon');
  window.isPlaylistActive = queue.length > 0;
  var elapsed = Date.now() - lastSyncTime;
  if (!(!playing && (document.hidden || elapsed < 5000))) window.isPlaylistPlaying = playing;
  if (window.isLiveStreamActive) return;
  // DJ info bar elements (single source of truth — previously duplicated in mobile.js)
  var djInfoBar = document.querySelector('.dj-info-bar');
  var controlsLabel = document.getElementById('controlsLabel');
  var controlsDjName = document.getElementById('controlsDjName');
  var npTrackTitle = document.getElementById('npTrackTitle');
  var bottomDurationBox = document.getElementById('bottomDurationBox');
  var bottomDurationLabel = document.getElementById('bottomDurationLabel');
  var streamGenre = document.getElementById('streamGenre');
  var streamInfoBar = document.getElementById('streamInfoBar');
  if (queue.length > 0) {
    if (offlineOverlay) offlineOverlay.classList.add('hidden');
    if (audioPlayer) audioPlayer.classList.add('hidden');
    if (hlsVideo) hlsVideo.classList.add('hidden');
    if (playlistPlayer) { playlistPlayer.classList.remove('hidden'); playlistPlayer.style.display = 'block'; }
    if (videoPlayer) { videoPlayer.classList.remove('hidden'); videoPlayer.style.display = 'block'; videoPlayer.style.opacity = '1'; }
    if (playBtn) {
      playBtn.disabled = false;
      var timeSinceSync = Date.now() - lastSyncTime;
      if (!(!playing && (document.hidden || timeSinceSync < 5000))) {
        if (playing) { if (playIcon) playIcon.classList.add('hidden'); if (pauseIcon) pauseIcon.classList.remove('hidden'); playBtn.classList.add('playing'); showPlaylistWave(); }
        else { if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); pausePlaylistWave(); }
      }
    }
    // Update DJ info bar for playlist mode
    if (djInfoBar) djInfoBar.classList.add('playlist-mode');
    if (streamInfoBar) streamInfoBar.classList.add('playlist-mode');
    var currentIndex = e.detail.currentIndex || 0;
    var currentTrack = queue[currentIndex];
    if (controlsLabel) controlsLabel.textContent = 'NOW PLAYING';
    if (controlsDjName && currentTrack) {
      var title = currentTrack.title || '';
      controlsDjName.textContent = title.length > 50 ? title.substring(0, 50) + '...' : title;
    }
    if (npTrackTitle) npTrackTitle.textContent = '';
    if (bottomDurationBox) bottomDurationBox.style.display = 'flex';
    if (bottomDurationLabel) bottomDurationLabel.textContent = 'LEFT';
    if (streamGenre) streamGenre.style.display = 'none';
    window.emojiAnimationsEnabled = true; setReactionButtonsEnabled(true); setChatEnabled(true);
    if (!window.isLiveStreamActive) {
      var badge = document.getElementById('liveBadge'); var statusText = document.getElementById('liveStatusText');
      var fsBadge = document.getElementById('fsLiveBadge'); var fsStatus = document.getElementById('fsLiveStatus');
      if (badge) { badge.classList.remove('is-live', 'is-loading'); badge.classList.add('is-playlist'); }
      if (statusText) statusText.textContent = 'PLAYLIST ACTIVE';
      if (fsBadge) { fsBadge.classList.remove('is-live', 'is-loading'); fsBadge.classList.add('is-playlist'); }
      if (fsStatus) fsStatus.textContent = 'PLAYLIST ACTIVE';
    }
    if (!window.isLiveStreamActive && window.currentStreamId !== 'playlist-global') {
      window.currentStreamId = 'playlist-global'; setupChat('playlist-global'); joinStream('playlist-global');
    }
  } else {
    if (playlistPlayer) playlistPlayer.classList.add('hidden');
    // Reset DJ info bar from playlist mode
    if (djInfoBar) djInfoBar.classList.remove('playlist-mode');
    if (streamInfoBar) streamInfoBar.classList.remove('playlist-mode');
    if (controlsLabel) controlsLabel.textContent = 'NOW PLAYING';
    if (npTrackTitle) npTrackTitle.textContent = '';
    if (controlsDjName && !window.isLiveStreamActive && !window.streamDetectedThisSession && !window.currentStreamData) {
      controlsDjName.textContent = '--';
    }
    if (bottomDurationBox) bottomDurationBox.style.display = 'none';
    if (streamGenre) streamGenre.style.display = '';
    var recentSync = (Date.now() - lastSyncTime) < 5000;
    if (!window.isLiveStreamActive && offlineOverlay && !recentSync && !streamDetectedThisSession) offlineOverlay.classList.remove('hidden');
    if (playBtn && !window.isLiveStreamActive && !recentSync) { playBtn.disabled = true; if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); }
    if (!window.isLiveStreamActive && !recentSync && !streamDetectedThisSession) {
      window.emojiAnimationsEnabled = false; setReactionButtonsEnabled(false); setChatEnabled(false);
      if (window.currentStreamId === 'playlist-global') window.currentStreamId = null;
      var badge2 = document.getElementById('liveBadge'); var statusText2 = document.getElementById('liveStatusText');
      var fsBadge2 = document.getElementById('fsLiveBadge'); var fsStatus2 = document.getElementById('fsLiveStatus');
      if (badge2) badge2.classList.remove('is-live', 'is-playlist', 'is-loading'); if (statusText2) statusText2.textContent = 'OFFLINE';
      if (fsBadge2) fsBadge2.classList.remove('is-live', 'is-playlist', 'is-loading'); if (fsStatus2) fsStatus2.textContent = 'OFFLINE';
      var oo = document.getElementById('offlineOverlay'); var oi = document.getElementById('offlineIconText');
      var om = document.getElementById('offlineMainText'); var os = document.getElementById('offlineSubText');
      if (oo) oo.classList.remove('is-loading'); if (oi) oi.textContent = 'OFFLINE';
      if (om) om.textContent = 'No one is streaming right now'; if (os) os.textContent = 'The playlist will start in a moment';
    }
  }
}

function handlePlaylistStateChange(e) {
  var playing = e.detail.isPlaying;
  var playBtn = document.getElementById('playBtn'); var playIcon = document.getElementById('playIcon'); var pauseIcon = document.getElementById('pauseIcon');
  if (window.isLiveStreamActive) return; if (!playing && document.hidden) return;
  var elapsed = Date.now() - lastSyncTime; if (!playing && elapsed < 5000) return;
  window.isPlaylistPlaying = playing;
  if (playing) { if (playBtn) { playBtn.disabled = false; if (playIcon) playIcon.classList.add('hidden'); if (pauseIcon) pauseIcon.classList.remove('hidden'); playBtn.classList.add('playing'); } window.emojiAnimationsEnabled = true; setReactionButtonsEnabled(true); showPlaylistWave(); }
  else { if (playBtn) { if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); } pausePlaylistWave(); }
}

function setupPlaylistListener() {
  window.removeEventListener('playlistUpdate', handlePlaylistUpdate); window.addEventListener('playlistUpdate', handlePlaylistUpdate);
  window.removeEventListener('playlistStateChange', handlePlaylistStateChange); window.addEventListener('playlistStateChange', handlePlaylistStateChange);
  setTimeout(function() { syncPlayButtonWithPlaylist(); if (window.playlistManager && typeof window.playlistManager.renderUI === 'function') window.playlistManager.renderUI(); }, 100);
}

function setupPlaylistPlayButton() {
  var playBtn = document.getElementById('playBtn'); if (!playBtn) return;
  playBtn.onclick = async function() {
    var playIcon = document.getElementById('playIcon'); var pauseIcon = document.getElementById('pauseIcon');
    var hlsVideo = document.getElementById('hlsVideoElement'); var audioEl = document.getElementById('audioElement');
    var playlistPlayer = document.getElementById('playlistPlayer');
    if (playlistPlayer && !playlistPlayer.classList.contains('hidden') && window.playlistManager && !window.isLiveStreamActive) {
      var pm = window.playlistManager; var isActPlaying = pm.isActuallyPlaying || false;
      try { if (isActPlaying) { await pm.pause(); window.isPlaylistPlaying = false; if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); pausePlaylistWave(); } else { await pm.resume(); window.isPlaylistPlaying = true; if (playIcon) playIcon.classList.add('hidden'); if (pauseIcon) pauseIcon.classList.remove('hidden'); playBtn.classList.add('playing'); showPlaylistWave(); } } catch (e) { console.error('[PlayBtn] Playlist error:', e); }
      return;
    }
    var videoVisible = document.getElementById('videoPlayer') && !document.getElementById('videoPlayer').classList.contains('hidden');
    var audioVisible = document.getElementById('audioPlayer') && !document.getElementById('audioPlayer').classList.contains('hidden');
    if (hlsVideo && videoVisible && !audioVisible && window.isLiveStreamActive) {
      if (hlsVideo.paused) { rememberAutoplay(); setLiveStreamPlaying(true); initGlobalAudioAnalyzer(hlsVideo); var ctx = getGlobalAudioContext(); if (ctx && ctx.state === 'suspended') ctx.resume(); hlsVideo.muted = false; try { await hlsVideo.play(); } catch (e) { console.error('[PlayBtn] HLS play error:', e); } }
      else { hlsVideo.pause(); setLiveStreamPlaying(false); }
    } else if (audioEl && window.isLiveStreamActive) {
      if (audioEl.paused) { rememberAutoplay(); setLiveStreamPlaying(true); initGlobalAudioAnalyzer(audioEl); var ctx2 = getGlobalAudioContext(); if (ctx2 && ctx2.state === 'suspended') ctx2.resume(); audioEl.muted = false; try { await audioEl.play(); if (playIcon) playIcon.classList.add('hidden'); if (pauseIcon) pauseIcon.classList.remove('hidden'); playBtn.classList.add('playing'); startGlobalMeters(); } catch (e) { console.error('[PlayBtn] Audio play error:', e); } }
      else { audioEl.pause(); setLiveStreamPlaying(false); if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); stopGlobalMeters(); }
    } else if (window.playlistManager && !window.isLiveStreamActive) {
      var pm2 = window.playlistManager; var isActPlaying2 = pm2.isActuallyPlaying || false;
      try { if (isActPlaying2) { await pm2.pause(); window.isPlaylistPlaying = false; if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); pausePlaylistWave(); } else { if (pm2.queue && pm2.queue.length > 0) await pm2.resume(); else if (pm2.startAutoPlay) await pm2.startAutoPlay(); window.isPlaylistPlaying = true; if (playIcon) playIcon.classList.add('hidden'); if (pauseIcon) pauseIcon.classList.remove('hidden'); playBtn.classList.add('playing'); showPlaylistWave(); if (playlistPlayer) playlistPlayer.classList.remove('hidden'); } } catch (e) { console.error('[PlayBtn] Fallback playlist error:', e); }
    }
  };
}

function getPlaylistManagerRef() {
  playlistManager = window.playlistManager || null;
  if (playlistManager) { var slider = document.getElementById('volumeSlider'); if (slider) playlistManager.setVolume(parseInt(slider.value)); syncPlayButtonWithPlaylist(); }
  else { setTimeout(function() { if (!playlistManager && window.playlistManager) getPlaylistManagerRef(); }, 500); }
  return playlistManager;
}

function syncPlayButtonWithPlaylist(retries) {
  if (typeof retries === 'undefined') retries = 0;
  var pm = window.playlistManager; var playBtn = document.getElementById('playBtn'); var playIcon = document.getElementById('playIcon'); var pauseIcon = document.getElementById('pauseIcon');
  var playlistPlayer = document.getElementById('playlistPlayer'); var offlineOverlay = document.getElementById('offlineOverlay');
  if (window.isLiveStreamActive) return;
  if (!pm) { if (retries < 5) setTimeout(function() { syncPlayButtonWithPlaylist(retries + 1); }, 500); return; }
  var hasQueue = false; var isPlaying = false;
  if (pm.queue && pm.queue.length > 0) { hasQueue = true; isPlaying = pm.isPlaying; }
  else if (pm.playlist && pm.playlist.queue && pm.playlist.queue.length > 0) { hasQueue = true; isPlaying = pm.playlist.isPlaying; }
  else if (playlistPlayer && !playlistPlayer.classList.contains('hidden')) { hasQueue = true; isPlaying = (playBtn && playBtn.classList.contains('playing')) || false; }
  else if (window.isPlaylistActive) { hasQueue = true; isPlaying = window.isPlaylistPlaying || false; }
  if (hasQueue) {
    lastSyncTime = Date.now();
    if (playBtn) { playBtn.disabled = false; if (isPlaying) { if (playIcon) playIcon.classList.add('hidden'); if (pauseIcon) pauseIcon.classList.remove('hidden'); playBtn.classList.add('playing'); showPlaylistWave(); } else { if (playIcon) playIcon.classList.remove('hidden'); if (pauseIcon) pauseIcon.classList.add('hidden'); playBtn.classList.remove('playing'); pausePlaylistWave(); } }
    if (playlistPlayer) { playlistPlayer.classList.remove('hidden'); playlistPlayer.style.display = 'block'; }
    if (offlineOverlay) offlineOverlay.classList.add('hidden');
    window.isPlaylistActive = true; window.isPlaylistPlaying = isPlaying; window.emojiAnimationsEnabled = true; setReactionButtonsEnabled(true); setChatEnabled(true);
  } else if (retries < 5) { setTimeout(function() { syncPlayButtonWithPlaylist(retries + 1); }, 500); }
}

// --- Stream view registration ---
async function registerStreamView(streamId) {
  if (!streamId) return;
  var user = auth && auth.currentUser; var userId = (user && user.uid) || ('anon-' + Math.random().toString(36).substr(2, 9));
  var userName = (window.currentUserInfo && window.currentUserInfo.name) || (user && user.displayName) || 'Viewer';
  try { var ctrl = new AbortController(); var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    var resp = await fetch('/api/livestream/listeners/', { signal: ctrl.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'join', streamId: streamId, userId: userId, userName: userName, avatarUrl: (user && user.photoURL) || null }) });
    clearTimeout(timer); if (!resp.ok) return; var data = await resp.json(); var viewerEl = document.getElementById('viewerCount');
    if (viewerEl && data.success && data.totalViews) viewerEl.textContent = data.totalViews;
  } catch (e) {}
}

// --- Heartbeat ---
async function joinStream(streamId) {
  if (!sessionStorage.getItem('viewerSessionId')) sessionStorage.setItem('viewerSessionId', 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
  viewerSessionId = sessionStorage.getItem('viewerSessionId');
  sendHeartbeat(streamId);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(function() { sendHeartbeat(currentStream ? currentStream.id : 'playlist-global'); }, 60000);
  window.addEventListener('beforeunload', function() { if (viewerSessionId) { var sid = currentStream ? currentStream.id : 'playlist-global'; navigator.sendBeacon('/api/livestream/heartbeat/', JSON.stringify({ action: 'leave', streamId: sid, sessionId: viewerSessionId })); } });
}

async function sendHeartbeat(streamId) {
  try { var user = window.liveStreamState && window.liveStreamState.currentUser;
    var body = { action: 'heartbeat', streamId: streamId, userId: viewerSessionId };
    if (user) { body.userId = user.uid; body.userName = user.displayName || (user.email && user.email.split('@')[0]) || 'User'; body.avatarUrl = user.photoURL || null; } else { body.userName = 'Viewer'; }
    var ctrl = new AbortController(); var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    var resp = await fetch('/api/livestream/listeners/', { signal: ctrl.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    clearTimeout(timer); if (!resp.ok) { console.warn('[Heartbeat] Request failed:', resp.status); return; } var data = await resp.json(); var count = data.activeViewers || 0; var chatViewers = document.getElementById('chatViewers');
    if (chatViewers) { var label = currentStream ? 'watching' : 'listening'; chatViewers.textContent = count + ' ' + label; }
  } catch (e) { console.warn('[Heartbeat] Failed:', e); }
}

async function refreshViewerCount(streamId) { if (streamId && viewerSessionId) sendHeartbeat(streamId); }

// --- Duration timer ---
function startDurationTimer(startedAt) {
  if (!startedAt) return;
  function update() { var start = new Date(startedAt); var now = new Date(); var total = Math.floor((now.getTime() - start.getTime()) / 1000); var h = Math.floor(total / 3600); var m = Math.floor((total % 3600) / 60); var s = total % 60; var text = h > 0 ? h + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0') : m + ':' + s.toString().padStart(2, '0'); var el = document.getElementById('streamDuration'); if (el) el.textContent = text; }
  if (durationTimerInterval) clearInterval(durationTimerInterval); update(); durationTimerInterval = setInterval(update, 1000);
}

// --- Auth listener ---
function setupAuthListener() {
  onAuthStateChanged(auth, function(user) {
    currentUser = user; window.liveStreamState.currentUser = user; setChatCurrentUser(user);
    var loginPrompt = document.getElementById('loginPrompt'); var chatForm = document.getElementById('chatForm');
    if (user) { if (loginPrompt) loginPrompt.classList.add('hidden'); if (chatForm) chatForm.classList.remove('hidden');
      activeUsers.set(user.uid, { id: user.uid, name: user.displayName || (user.email && user.email.split('@')[0]) || 'User', avatar: user.photoURL || null, lastSeen: Date.now() });
      if (window.updateOnlineUsers) window.updateOnlineUsers(window.getOnlineViewers()); if (currentStream) loadUserReactions(currentStream.id);
    } else { if (loginPrompt) loginPrompt.classList.remove('hidden'); if (chatForm) chatForm.classList.add('hidden'); }
  });
}

// --- Reactions ---
function setupReactions(streamId) {
  var shareBtn = document.getElementById('shareBtn');
  if (shareBtn) { shareBtn.onclick = function() { var url = window.location.href; if (navigator.share) { navigator.share({ title: (currentStream && currentStream.title) || 'Live Stream', text: 'Check out this live stream on Fresh Wax!', url: url }); } else { navigator.clipboard.writeText(url); alert('Link copied!'); } }; }
  if (currentUser) loadUserReactions(streamId);
}

async function loadUserReactions(streamId) {
  if (!currentUser) return;
  try { var token = await currentUser.getIdToken(); var ctrl = new AbortController(); var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    var resp = await fetch('/api/livestream/react/?streamId=' + streamId + '&userId=' + currentUser.uid, { signal: ctrl.signal, headers: { Authorization: 'Bearer ' + token } });
    clearTimeout(timer); if (!resp.ok) return; var data = await resp.json();
    if (data.success) { var likeBtn = document.getElementById('likeBtn'); if (likeBtn) likeBtn.classList.toggle('liked', data.hasLiked);
      if (data.userRating) { document.querySelectorAll('.star').forEach(function(star, idx) { star.classList.remove('active', 'user-rated'); if (idx < data.userRating) star.classList.add('active'); if (idx === data.userRating - 1) star.classList.add('user-rated'); }); } }
  } catch (e) { console.error('[Reaction] Load error:', e); }
}

// --- Stop live stream ---
function stopLiveStream() {
  releaseWakeLock(); destroyHlsPlayer();
  var videoEl = document.getElementById('hlsVideoElement'); if (videoEl) { try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (e) {} }
  var audioEl = document.getElementById('audioElement'); if (audioEl) { try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch (e) {} }
  stopGlobalMeters(); currentStream = null; window.currentStreamData = null; window.isLiveStreamActive = false; window.streamDetectedThisSession = false; setLiveStreamPlaying(false); setChatCurrentStream(null);
  var relayAttr = document.getElementById('relayAttribution'); if (relayAttr) relayAttr.style.display = 'none';
}

// --- Offline state ---
function showOfflineState(scheduled) {
  if (window.currentStreamData && (streamDetectedThisSession || window.isLiveStreamActive)) return;
  window.isLiveStreamActive = false; setLiveStreamPlaying(false);
  var initOverlay = document.getElementById('initializingOverlay'); if (initOverlay) initOverlay.classList.add('hidden');
  var badge = document.getElementById('liveBadge'); var statusText = document.getElementById('liveStatusText');
  var offOverlay = document.getElementById('offlineOverlay'); var offIcon = document.getElementById('offlineIconText');
  var offMain = document.getElementById('offlineMainText'); var offSub = document.getElementById('offlineSubText');
  if (badge) badge.classList.remove('is-loading', 'is-live'); if (statusText) statusText.textContent = 'OFFLINE';
  if (offOverlay) offOverlay.classList.remove('is-loading'); if (offIcon) offIcon.textContent = 'OFFLINE';
  if (offMain) offMain.textContent = 'No one is streaming right now'; if (offSub) offSub.textContent = 'The playlist will start in a moment';
  var pm = window.playlistManager; var hasPlaylist = pm && pm.queue && pm.queue.length > 0; var timeSinceSync = Date.now() - lastSyncTime;
  if (!hasPlaylist && timeSinceSync >= 3000 && !streamDetectedThisSession) { window.emojiAnimationsEnabled = false; setReactionButtonsEnabled(false); setChatEnabled(false); }
  var relay = document.getElementById('relayAttribution'); if (relay) relay.style.display = 'none';
  if (typeof window.renderTodaySchedule === 'function') window.renderTodaySchedule();
  var offState = document.getElementById('offlineState'); if (offState) offState.classList.remove('hidden');
  var liveState = document.getElementById('liveState'); if (liveState) liveState.classList.add('hidden');
  if (scheduled && scheduled.length > 0) {
    var schedSection = document.getElementById('scheduledStreams'); if (schedSection) schedSection.classList.remove('hidden');
    var schedList = document.getElementById('scheduledList');
    if (schedList) { schedList.innerHTML = scheduled.map(function(s) { return '<div class="scheduled-item" style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: #1a1a1a; border-radius: 8px; margin-bottom: 0.5rem;"><span style="color: #dc2626; font-weight: 600; min-width: 80px; font-size: 0.875rem;">' + new Date(s.scheduledFor).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</span><div style="min-width: 0; flex: 1;"><div style="color: #fff; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + escapeHtml(s.title) + '</div><div style="color: #888; font-size: 0.875rem;">' + escapeHtml(s.djName) + '</div></div></div>'; }).join(''); }
  }
}

// --- Show live stream ---
function showLiveStream(streamData) {
  try { currentStream = streamData; window.isLiveStreamActive = true; streamDetectedThisSession = true; window.streamDetectedThisSession = true; window.liveStreamState.currentStream = streamData; window.emojiAnimationsEnabled = true; setReactionButtonsEnabled(true); setChatEnabled(true); setChatCurrentStream(streamData); requestWakeLock(); hidePlaylistWave(); showLiveMeters(); } catch (e) { console.error('[showLiveStream] Error in initial setup:', e); }
  try {
    window.currentStreamId = streamData.id; window.currentStreamData = streamData; window.firebaseAuth = auth;
    if (streamData.isRelay) { if (typeof window.renderTodaySchedule === 'function') window.renderTodaySchedule(); var djNameCard = document.getElementById('liveDjNameCard'); if (djNameCard) djNameCard.textContent = streamData.title || 'Relay Stream'; }
    var relayAttr = document.getElementById('relayAttribution'); if (relayAttr) relayAttr.style.display = streamData.isRelay ? 'block' : 'none';
    registerStreamView(streamData.id);
    var offState = document.getElementById('offlineState'); if (offState) offState.classList.add('hidden');
    var offOverlay = document.getElementById('offlineOverlay'); if (offOverlay) offOverlay.remove();
    var fsOffOverlay = document.getElementById('fsOfflineOverlay'); if (fsOffOverlay) fsOffOverlay.classList.add('hidden');
    var liveState = document.getElementById('liveState'); if (liveState) liveState.classList.remove('hidden');
    var initOverlay = document.getElementById('initializingOverlay'); if (initOverlay) { initOverlay.classList.add('fade-out', 'hidden'); initOverlay.style.cssText = 'display: none !important; animation: none !important;'; }
    var playlistOverlay = document.getElementById('playlistLoadingOverlay'); if (playlistOverlay) playlistOverlay.classList.add('hidden');
    var badge = document.getElementById('liveBadge'); var statusText = document.getElementById('liveStatusText');
    if (badge) { badge.classList.remove('is-loading'); badge.classList.add('is-live'); } if (statusText) statusText.textContent = 'LIVE';
    var fsBadge = document.getElementById('fsLiveBadge'); var fsStatus = document.getElementById('fsLiveStatus');
    if (fsBadge) { fsBadge.classList.remove('is-loading'); fsBadge.classList.add('is-live'); } if (fsStatus) fsStatus.textContent = 'LIVE';
    var djInfoBar = document.querySelector('.dj-info-bar'); if (djInfoBar) djInfoBar.classList.add('is-live');
    var displayName = streamData.isRelay ? (streamData.title || 'Relay Stream') : streamData.djName;
    var uiFields = { djName: displayName, controlsDjName: displayName || 'DJ', streamGenre: streamData.genre || 'Jungle / D&B', viewerCount: streamData.totalViews || streamData.currentViewers || 0, likeCount: streamData.totalLikes || 0, avgRating: (streamData.averageRating || 0).toFixed(1), streamDescription: streamData.description || 'No description', audioDjName: displayName || 'DJ', audioShowTitle: streamData.isRelay ? (streamData.relayNowPlaying ? 'Now Playing: ' + streamData.relayNowPlaying : 'Relayed from ' + ((streamData.relaySource && streamData.relaySource.stationName) || 'External Station')) : (streamData.title || 'Live on Fresh Wax'), fsStreamTitle: streamData.title || 'Live Stream', fsDjName: displayName || 'DJ', fsAudioDjName: displayName || 'DJ' };
    Object.keys(uiFields).forEach(function(key) { var el = document.getElementById(key); if (!el) return; var isNameField = (key === 'controlsDjName' || key === 'djName' || key === 'audioDjName' || key === 'fsDjName' || key === 'fsAudioDjName'); if (streamData.isRelay && isNameField) el.innerHTML = '<span style="color: #ef4444;">' + escapeHtml(uiFields[key]) + '</span>'; else el.textContent = uiFields[key]; });
    var streamTitle = document.getElementById('streamTitle');
    if (streamTitle) { if (streamData.isRelay && streamData.relaySource && streamData.relaySource.stationName) streamTitle.innerHTML = '<span class="title-live">RELAY</span> <span class="title-relay-from">from ' + escapeHtml(streamData.relaySource.stationName) + '</span>'; else streamTitle.innerHTML = '<span class="title-live">LIVE</span> <span class="title-session">SESSION</span>'; }
    var audioBadge = document.getElementById('audioBadgeText'); var fsAudioBadge = document.getElementById('fsAudioBadgeText');
    if (streamData.isRelay) { if (audioBadge) audioBadge.textContent = 'RELAY'; if (fsAudioBadge) fsAudioBadge.textContent = 'RELAY'; } else { if (audioBadge) audioBadge.textContent = 'AUDIO ONLY'; if (fsAudioBadge) fsAudioBadge.textContent = 'AUDIO ONLY'; }
    var avatarSrc = streamData.isRelay ? '/place-holder.webp' : streamData.djAvatar; var djAvatar = document.getElementById('djAvatar'); var streamCover = document.getElementById('streamCover'); var vinyl1 = document.getElementById('vinylDjAvatar'); var vinyl2 = document.getElementById('vinylDjAvatar2');
    if (avatarSrc && djAvatar) djAvatar.src = avatarSrc; if (streamData.coverImage && streamCover) streamCover.src = streamData.coverImage;
    var vinylSrc = streamData.isRelay ? '/place-holder.webp' : streamData.djAvatar; if (vinylSrc && vinyl1) vinyl1.src = vinylSrc; if (vinylSrc && vinyl2) vinyl2.src = vinylSrc;
    var fsDjAvatar = document.getElementById('fsDjAvatar'); var fsVinyl1 = document.getElementById('fsVinylDjAvatar'); var fsVinyl2 = document.getElementById('fsVinylDjAvatar2');
    var fsAvatar = streamData.isRelay ? '/place-holder.webp' : (streamData.djAvatar || '/place-holder.webp'); if (fsDjAvatar) fsDjAvatar.src = fsAvatar; if (fsVinyl1) fsVinyl1.src = fsAvatar; if (fsVinyl2) fsVinyl2.src = fsAvatar;
    var isPlaceholderOrAudio = streamData.broadcastMode === 'placeholder' || streamData.broadcastMode === 'audio';
    var hlsDeps = { shouldAutoplay: shouldAutoplay, wasLiveStreamPlaying: wasLiveStreamPlaying, rememberAutoplay: rememberAutoplay, setLiveStreamPlaying: setLiveStreamPlaying };
    if (streamData.streamSource === 'twitch' && streamData.twitchChannel) setupTwitchPlayer(streamData);
    else if (isPlaceholderOrAudio || streamData.isRelay || (streamData.streamSource !== 'red5' && !streamData.hlsUrl)) {
      if (streamData.isRelay && streamData.relaySource && streamData.relaySource.url) { var relayUrl = streamData.relaySource.url; var relayPath = null; if (relayUrl.includes('relay.freshwax.co.uk/')) relayPath = relayUrl.split('relay.freshwax.co.uk/')[1]; else if (relayUrl.includes('/api/relay-stream/?station=')) relayPath = relayUrl.split('station=')[1]; streamData.audioStreamUrl = relayPath ? 'https://relay.freshwax.co.uk/' + relayPath : relayUrl; }
      else if (!streamData.audioStreamUrl) streamData.audioStreamUrl = 'https://icecast.freshwax.co.uk/live';
      setupAudioPlayer(streamData, hlsDeps);
    } else setupHlsPlayer(streamData, hlsDeps);
    var twitchUser = streamData.twitchChannel || streamData.twitchUsername; if (window.setupFsTwitchChat) window.setupFsTwitchChat(twitchUser);
    joinStream(streamData.id); setupChat(streamData.id); startDurationTimer(streamData.startedAt); setupReactions(streamData.id);
  } catch (e) { console.error('[showLiveStream] Error in UI setup:', e); }
}

// --- Check live status ---
async function checkLiveStatus(forceRefresh) {
  if (typeof forceRefresh === 'undefined') forceRefresh = false;
  try { if (!playlistManager) getPlaylistManagerRef(); var ts = Date.now(); var freshParam = forceRefresh ? '&fresh=1' : '';
    var ctrl = new AbortController(); var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    var resp = await fetch('/api/livestream/status/?_t=' + ts + freshParam, { signal: ctrl.signal }); clearTimeout(timer); if (!resp.ok) return; var data = await resp.json();
    if (data.success && data.isLive && data.primaryStream) {
      wasLiveStreamActive = true; streamEndedAt = null;
      if (playlistManager && playlistManager.isPlaying) { await playlistManager.pause(); playlistManager.wasPausedForStream = true; }
      var ppEl = document.getElementById('playlistPlayer'); if (ppEl) ppEl.classList.add('hidden');
      try { showLiveStream(data.primaryStream); } catch (e) { console.error('[checkLiveStatus] Error calling showLiveStream:', e); }
    } else {
      if (getHlsPlayer() || window.audioHlsPlayer || window.isLiveStreamActive) stopLiveStream();
      if (wasLiveStreamActive && !streamEndedAt) { streamEndedAt = Date.now(); if (typeof window.refreshSchedule === 'function') window.refreshSchedule(); }
      var secsSinceEnd = streamEndedAt ? (Date.now() - streamEndedAt) / 1000 : 999; var canResumePlaylist = secsSinceEnd >= 10;
      if (canResumePlaylist) { wasLiveStreamActive = false; streamEndedAt = null;
        if (!playlistManager && typeof window.loadPlaylistModule === 'function') { await window.loadPlaylistModule({ silent: true }); await new Promise(function(r) { setTimeout(r, 500); }); playlistManager = window.playlistManager; }
        if (playlistManager && playlistManager.wasPausedForStream && playlistManager.queue.length > 0) { await playlistManager.resume(); playlistManager.wasPausedForStream = false; }
        else if (playlistManager && (!playlistManager.isPlaying || playlistManager.queue.length === 0)) { await playlistManager.startAutoPlay(); }
      }
      var vp = document.getElementById('videoPlayer'); var hlsVid = document.getElementById('hlsVideoElement'); var pp = document.getElementById('playlistPlayer');
      if (canResumePlaylist && playlistManager && playlistManager.queue && playlistManager.queue.length > 0) { if (hlsVid) hlsVid.classList.add('hidden'); if (pp) pp.classList.remove('hidden'); if (vp) { vp.classList.remove('hidden'); vp.style.opacity = '1'; } }
      else if (canResumePlaylist) { if (vp) { vp.style.opacity = '0'; setTimeout(function() { vp.classList.add('hidden'); }, 300); } }
      else { if (hlsVid) hlsVid.classList.remove('hidden'); if (pp) pp.classList.add('hidden'); }
      showOfflineState(data.scheduled || []);
    }
  } catch (e) { console.error('Error checking live status:', e); showOfflineState([]); }
}

window.checkLiveStatus = checkLiveStatus;

// --- GIF sending (global) ---
window.sendGifMessage = async function(url, id) {
  if (!currentUser) { console.error('[GIF] No current user - not logged in'); alert('Please log in to send GIFs'); return; }
  if (!currentStream) { console.error('[GIF] No current stream'); alert('No active stream'); return; }
  await sendGiphyMessage(url, id);
};

// --- Reply system ---
window.replyingTo = null;
window.replyToMessage = function(id, userName, preview) { window.replyingTo = { id: id, userName: userName, preview: preview }; var indicator = document.getElementById('replyIndicator'); if (indicator) { indicator.innerHTML = '<span style="color: #888;">Replying to </span><span style="color: #dc2626; font-weight: 600;">' + escapeHtml(userName) + '</span><span style="color: #666; margin-left: 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; display: inline-block; vertical-align: bottom;">' + escapeHtml(preview.substring(0, 30)) + (preview.length > 30 ? '...' : '') + '</span><button onclick="window.cancelReply()" style="margin-left: auto; background: none; border: none; color: #888; cursor: pointer; font-size: 1rem;">\u00D7</button>'; indicator.style.display = 'flex'; } var chatInput = document.getElementById('chatInput'); if (chatInput) chatInput.focus(); };
window.cancelReply = function() { window.replyingTo = null; var indicator = document.getElementById('replyIndicator'); if (indicator) indicator.style.display = 'none'; };
window.sendGifMessage = sendGiphyMessage;

// --- Debug ---
window.debugReactions = function() { return { emojiAnimationsEnabled: window.emojiAnimationsEnabled, currentStreamId: window.currentStreamId, isLiveStreamActive: window.isLiveStreamActive, pusherConnected: !!window.Pusher, chatChannel: (window.pusherChannel && window.pusherChannel.name) || 'not subscribed', PUSHER_CONFIG: window.PUSHER_CONFIG }; };

// --- Main init ---
async function init() {
  try { var initOverlay = document.getElementById('initializingOverlay'); var offOverlay = document.getElementById('offlineOverlay');
    setTimeout(function() { if (initOverlay && !initOverlay.classList.contains('hidden') && !initOverlay.classList.contains('fade-out')) initOverlay.classList.add('fade-out'); if (offOverlay && offOverlay.classList.contains('is-loading')) { offOverlay.style.opacity = '0'; offOverlay.style.transition = 'opacity 0.5s ease-out'; } }, 5000);
    setTimeout(function() { if (initOverlay && !initOverlay.classList.contains('hidden')) { initOverlay.classList.add('hidden'); initOverlay.style.display = 'none'; } if (offOverlay && offOverlay.classList.contains('is-loading')) { offOverlay.classList.add('hidden'); offOverlay.style.display = 'none'; } }, 10000);
  } catch (e) { console.error('[Init] Error setting up overlay timers:', e); }

  function updateDjInfoUI(sd) { var name = sd.isRelay ? (sd.title || 'Relay Stream') : sd.djName; var controlsDjName = document.getElementById('controlsDjName'); var controlsSetTitle = document.getElementById('controlsSetTitle'); var djInfoBar = document.querySelector('.dj-info-bar'); if (controlsDjName) { if (sd.isRelay && sd.title) controlsDjName.innerHTML = '<span style="color: #ef4444;">' + escapeHtml(sd.title) + '</span>'; else controlsDjName.textContent = name || 'DJ'; } if (controlsSetTitle) controlsSetTitle.textContent = sd.title || 'Live Set'; if (djInfoBar) djInfoBar.classList.add('is-live'); var liveBadge = document.getElementById('liveBadge'); var liveStatusText = document.getElementById('liveStatusText'); var onAirText = document.getElementById('onAirText'); if (liveBadge) { liveBadge.classList.remove('is-loading'); liveBadge.classList.add('is-live'); } if (liveStatusText) liveStatusText.classList.add('hidden'); if (onAirText) onAirText.classList.remove('hidden'); var offOverlay2 = document.getElementById('offlineOverlay'); var initOverlay2 = document.getElementById('initializingOverlay'); if (offOverlay2) { offOverlay2.classList.add('hidden'); offOverlay2.remove(); } if (initOverlay2) initOverlay2.classList.add('hidden'); setReactionButtonsEnabled(true); setChatEnabled(true); }

  detectMobileDevice();
  if (window.isLiveStreamActive && window.currentStreamData) { streamDetectedThisSession = true; window.streamDetectedThisSession = true; window.emojiAnimationsEnabled = true; updateDjInfoUI(window.currentStreamData); setTimeout(function() { if (window.currentStreamData) updateDjInfoUI(window.currentStreamData); }, 200); }
  getPlaylistManagerRef(); setupPlaylistListener(); setupPlaylistPlayButton(); setupVolumeSlider(); setupAuthListener(); setupMobileFeatures(); checkLiveStatus();
  setupLiveStatusPusher({ onCheckLiveStatus: function(force) { checkLiveStatus(force); }, onStopLiveStream: function() { stopLiveStream(); wasLiveStreamActive = true; streamEndedAt = Date.now(); } });
  if (liveStatusPollInterval) clearInterval(liveStatusPollInterval);
  liveStatusPollInterval = setInterval(async function() { if (window.statusPusher && window.statusPusher.connection && window.statusPusher.connection.state === 'connected') return; await checkLiveStatus(); }, 60000);
  if (slowPollInterval) clearInterval(slowPollInterval);
  slowPollInterval = setInterval(async function() { await checkLiveStatus(); }, 120000);
  setTimeout(function() { if (window.isLiveStreamActive) { window.emojiAnimationsEnabled = true; setReactionButtonsEnabled(true); } else { window.emojiAnimationsEnabled = true; if (!window.currentStreamId || window.currentStreamId === 'playlist-global') { window.currentStreamId = 'playlist-global'; setupChat('playlist-global'); joinStream('playlist-global'); } } }, 500);
  setTimeout(function() { if (!window.isLiveStreamActive) syncPlayButtonWithPlaylist(); }, 1000);
  setTimeout(function() { if (!window.isLiveStreamActive) syncPlayButtonWithPlaylist(); }, 2500);
}

// --- Cleanup ---
function cleanupLiveStream() { if (durationTimerInterval) { clearInterval(durationTimerInterval); durationTimerInterval = null; } if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } cleanupHlsAbort(); cleanupUiControls(); }

// --- Lifecycle ---
window.addEventListener('beforeunload', function() { if (getIsRecording()) stopRecording(); cleanupLiveStream(); });
document.addEventListener('click', function(e) { var emojiPicker = document.getElementById('emojiPicker'); var emojiBtn = document.getElementById('emojiBtn'); if (emojiPicker && !emojiPicker.contains(e.target) && emojiBtn && !emojiBtn.contains(e.target)) { emojiPicker.classList.add('hidden'); emojiBtn.classList.remove('active'); } });

var isInitialized = false;
async function safeInit() { if (window.location.pathname.startsWith('/live')) { isInitialized = true; await init(); } }
safeInit();

document.addEventListener('astro:before-swap', function() { if (getIsRecording()) stopRecording(); cleanupLiveStream(); destroyHlsPlayer(); if (liveStatusPollInterval) { clearInterval(liveStatusPollInterval); liveStatusPollInterval = null; } if (slowPollInterval) { clearInterval(slowPollInterval); slowPollInterval = null; } isInitialized = false; streamDetectedThisSession = false; window.streamDetectedThisSession = false; });
document.addEventListener('astro:page-load', function() { isInitialized = false; resetChatMessages(); safeInit(); });
