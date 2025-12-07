// public/live-stream.js
// Fresh Wax Live Stream - Mobile-First Optimized
// Version: 2.0 - December 2025

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore, collection, query, where, orderBy, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ==========================================
// FIREBASE CONFIGURATION
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g",
  authDomain: "fresh-wax.firebaseapp.com",
  projectId: "fresh-wax",
  storageBucket: "fresh-wax.firebasestorage.app",
  messagingSenderId: "307622215498",
  appId: "1:307622215498:web:e66cee39e098fe973c7081"
};

// Prevent duplicate app initialization
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ==========================================
// STATE MANAGEMENT
// ==========================================
let currentUser = null;
let currentStream = null;
let viewerSessionId = null;
let isPlaying = false;
let chatUnsubscribe = null;

// Recording state
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingInterval = null;
let isRecording = false;

// HLS player instance
let hlsPlayer = null;

// Audio analyzer state
let globalAudioContext = null;
let globalAnalyserLeft = null;
let globalAnalyserRight = null;
let globalAnimationId = null;
let globalMediaSource = null;

// Mobile touch state
let touchStartY = 0;
let touchStartVolume = 0;

// GIPHY API Key from page
const GIPHY_API_KEY = window.GIPHY_API_KEY || '';

// Emoji categories for chat
const EMOJI_CATEGORIES = {
  music: ['🎵', '🎶', '🎧', '🎤', '🎹', '🥁', '🎸', '🎺', '🎷', '🔊', '📻', '💿'],
  reactions: ['🔥', '❤️', '💯', '🙌', '👏', '🤘', '✨', '💥', '⚡', '🌟', '💪', '👊'],
  faces: ['😍', '🥰', '😎', '🤩', '🥳', '😈', '👀', '🤯', '😱', '🫠', '💀', '😂'],
  vibes: ['🌴', '🌙', '🌊', '🍾', '🥂', '💨', '🌈', '☀️', '🌺', '🦋', '🐍', '🦁']
};

// ==========================================
// INITIALIZATION
// ==========================================
async function init() {
  // Check device type for optimizations
  detectMobileDevice();
  
  // Check live status
  await checkLiveStatus();
  
  // Setup auth listener
  setupAuthListener();
  
  // Setup mobile-specific features
  setupMobileFeatures();
}

// Detect mobile device
function detectMobileDevice() {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  document.body.classList.toggle('is-mobile', isMobile);
  document.body.classList.toggle('is-touch', isTouch);
  
  // Store for later use
  window.isMobileDevice = isMobile;
  window.isTouchDevice = isTouch;
}

// Setup mobile-specific features
function setupMobileFeatures() {
  // Prevent pull-to-refresh on player area
  const playerArea = document.querySelector('.player-column');
  if (playerArea) {
    playerArea.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        e.stopPropagation();
      }
    }, { passive: true });
  }
  
  // Setup swipe gestures for volume on mobile
  setupTouchVolumeControl();
  
  // Handle orientation changes
  window.addEventListener('orientationchange', handleOrientationChange);
  
  // Handle visibility changes (tab switching, screen lock)
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

// Touch volume control for mobile
function setupTouchVolumeControl() {
  const playerWrapper = document.querySelector('.player-wrapper');
  if (!playerWrapper || !window.isTouchDevice) return;
  
  playerWrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchStartY = e.touches[0].clientY;
      const volumeSlider = document.getElementById('volumeSlider');
      touchStartVolume = volumeSlider ? parseInt(volumeSlider.value) : 80;
    }
  }, { passive: true });
  
  playerWrapper.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && touchStartY) {
      const deltaY = touchStartY - e.touches[0].clientY;
      const volumeChange = Math.round(deltaY / 3); // Sensitivity
      const newVolume = Math.max(0, Math.min(100, touchStartVolume + volumeChange));
      
      const volumeSlider = document.getElementById('volumeSlider');
      if (volumeSlider) {
        volumeSlider.value = newVolume;
        volumeSlider.dispatchEvent(new Event('input'));
        
        // Show volume indicator
        showVolumeIndicator(newVolume);
      }
    }
  }, { passive: true });
  
  playerWrapper.addEventListener('touchend', () => {
    touchStartY = 0;
    hideVolumeIndicator();
  }, { passive: true });
}

// Show volume indicator overlay
function showVolumeIndicator(volume) {
  let indicator = document.getElementById('volumeIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'volumeIndicator';
    indicator.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.8);
      color: #fff;
      padding: 1rem 2rem;
      border-radius: 12px;
      font-size: 1.5rem;
      font-weight: bold;
      z-index: 9999;
      pointer-events: none;
      transition: opacity 0.2s;
    `;
    document.body.appendChild(indicator);
  }
  indicator.textContent = `🔊 ${volume}%`;
  indicator.style.opacity = '1';
}

// Hide volume indicator
function hideVolumeIndicator() {
  const indicator = document.getElementById('volumeIndicator');
  if (indicator) {
    indicator.style.opacity = '0';
    setTimeout(() => indicator.remove(), 200);
  }
}

// Handle orientation changes
function handleOrientationChange() {
  // Give the browser time to update dimensions
  setTimeout(() => {
    const isLandscape = window.innerWidth > window.innerHeight;
    document.body.classList.toggle('landscape', isLandscape);
    
    // Resize video player if needed
    const videoElement = document.getElementById('hlsVideoElement');
    if (videoElement && isPlaying) {
      videoElement.style.maxHeight = isLandscape ? '100vh' : '56.25vw';
    }
  }, 100);
}

// Handle visibility changes
function handleVisibilityChange() {
  if (document.hidden) {
    // Page hidden - audio continues in background on mobile
    console.log('[Live] Page hidden, audio continues');
  } else {
    // Page visible - refresh viewer count
    if (currentStream) {
      refreshViewerCount(currentStream.id);
    }
  }
}

// Refresh viewer count
async function refreshViewerCount(streamId) {
  try {
    const response = await fetch('/api/livestream/status');
    const result = await response.json();
    if (result.success && result.primaryStream) {
      const viewerCount = document.getElementById('viewerCount');
      if (viewerCount) viewerCount.textContent = result.primaryStream.currentViewers || 0;
    }
  } catch (e) {
    console.warn('[Live] Failed to refresh viewer count');
  }
}

// ==========================================
// STREAM STATUS CHECK
// ==========================================
async function checkLiveStatus() {
  try {
    const response = await fetch('/api/livestream/status');
    const result = await response.json();
    
    if (result.success && result.isLive && result.primaryStream) {
      showLiveStream(result.primaryStream);
    } else {
      showOfflineState(result.scheduled || []);
    }
  } catch (error) {
    console.error('Error checking live status:', error);
    showOfflineState([]);
  }
}

// Show offline state
function showOfflineState(scheduled) {
  document.getElementById('offlineState')?.classList.remove('hidden');
  document.getElementById('liveState')?.classList.add('hidden');
  
  if (scheduled.length > 0) {
    document.getElementById('scheduledStreams')?.classList.remove('hidden');
    const list = document.getElementById('scheduledList');
    if (list) {
      list.innerHTML = scheduled.map(s => {
        const date = new Date(s.scheduledFor);
        const timeStr = date.toLocaleString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });
        return `
          <div class="scheduled-item" style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: #1a1a1a; border-radius: 8px; margin-bottom: 0.5rem;">
            <span style="color: #dc2626; font-weight: 600; min-width: 80px; font-size: 0.875rem;">${timeStr}</span>
            <div style="min-width: 0; flex: 1;">
              <div style="color: #fff; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.title}</div>
              <div style="color: #888; font-size: 0.875rem;">${s.djName}</div>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

// ==========================================
// SHOW LIVE STREAM
// ==========================================
function showLiveStream(stream) {
  currentStream = stream;
  
  // Expose stream ID globally for reaction buttons
  window.currentStreamId = stream.id;
  window.firebaseAuth = auth;
  
  document.getElementById('offlineState')?.classList.add('hidden');
  document.getElementById('liveState')?.classList.remove('hidden');
  
  // Update stream info
  const elements = {
    streamTitle: stream.title,
    djName: stream.djName,
    streamGenre: stream.genre || 'Jungle / D&B',
    viewerCount: stream.currentViewers || 0,
    likeCount: stream.totalLikes || 0,
    avgRating: (stream.averageRating || 0).toFixed(1),
    streamDescription: stream.description || 'No description',
    audioDjName: stream.djName || 'DJ',
    audioShowTitle: stream.title || 'Live on Fresh Wax'
  };
  
  Object.entries(elements).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
  
  // Update images
  const djAvatar = document.getElementById('djAvatar');
  const streamCover = document.getElementById('streamCover');
  const vinylDjAvatar = document.getElementById('vinylDjAvatar');
  
  if (stream.djAvatar && djAvatar) djAvatar.src = stream.djAvatar;
  if (stream.coverImage && streamCover) streamCover.src = stream.coverImage;
  if (stream.djAvatar && vinylDjAvatar) vinylDjAvatar.src = stream.djAvatar;
  
  // Setup player based on stream type/source
  if (stream.streamSource === 'twitch' && stream.twitchChannel) {
    setupTwitchPlayer(stream);
  } else if (stream.streamSource === 'red5' || stream.hlsUrl) {
    setupHlsPlayer(stream);
  } else if (stream.streamSource === 'icecast' || stream.audioStreamUrl) {
    setupAudioPlayer(stream);
  } else {
    setupAudioPlayer(stream);
  }
  
  // Join as viewer
  joinStream(stream.id);
  
  // Setup chat
  setupChat(stream.id);
  
  // Start duration timer
  startDurationTimer(stream.startedAt);
  
  // Setup reactions
  setupReactions(stream.id);
}

// ==========================================
// HLS VIDEO PLAYER (Red5 Streams)
// ==========================================
function setupHlsPlayer(stream) {
  document.getElementById('audioPlayer')?.classList.add('hidden');
  document.getElementById('videoPlayer')?.classList.remove('hidden');
  
  const videoElement = document.getElementById('hlsVideoElement');
  const twitchEmbed = document.getElementById('twitchEmbed');
  
  if (videoElement) videoElement.classList.remove('hidden');
  if (twitchEmbed) twitchEmbed.classList.add('hidden');
  
  const hlsUrl = stream.hlsUrl || stream.videoStreamUrl;
  
  if (!hlsUrl) {
    console.error('No HLS URL available');
    setupAudioPlayer(stream);
    return;
  }
  
  console.log('[HLS] Setting up player with URL:', hlsUrl);
  
  // Video event handlers for LED meters
  function onVideoPlay() {
    initGlobalAudioAnalyzer(videoElement);
    if (globalAudioContext?.state === 'suspended') {
      globalAudioContext.resume();
    }
    startGlobalMeters();
  }
  
  function onVideoPause() {
    stopGlobalMeters();
  }
  
  if (videoElement) {
    videoElement.addEventListener('play', onVideoPlay);
    videoElement.addEventListener('pause', onVideoPause);
    videoElement.addEventListener('ended', onVideoPause);
    
    // Mobile-specific: Enable inline playback
    videoElement.setAttribute('playsinline', '');
    videoElement.setAttribute('webkit-playsinline', '');
    
    // Check if HLS is supported natively (Safari/iOS)
    if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = hlsUrl;
      videoElement.addEventListener('loadedmetadata', () => {
        // On mobile, wait for user interaction
        if (!window.isMobileDevice) {
          videoElement.play().catch(console.error);
        }
      });
    }
    // Use HLS.js for other browsers
    else if (window.Hls && Hls.isSupported()) {
      if (hlsPlayer) {
        hlsPlayer.destroy();
      }
      
      hlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        // Mobile optimizations
        maxBufferLength: window.isMobileDevice ? 30 : 60,
        maxMaxBufferLength: window.isMobileDevice ? 60 : 120
      });
      
      hlsPlayer.loadSource(hlsUrl);
      hlsPlayer.attachMedia(videoElement);
      
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[HLS] Manifest parsed, starting playback');
        if (!window.isMobileDevice) {
          videoElement.play().catch(console.error);
        }
      });
      
      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.error('[HLS] Error:', data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[HLS] Network error, recovering...');
              hlsPlayer.startLoad();
              setTimeout(() => {
                if (!isPlaying) {
                  showReconnecting();
                  hlsPlayer.loadSource(hlsUrl);
                }
              }, 3000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[HLS] Media error, recovering...');
              hlsPlayer.recoverMediaError();
              break;
            default:
              console.error('[HLS] Fatal error');
              hlsPlayer.destroy();
              showStreamError('Stream unavailable. The DJ may still be connecting.');
              setTimeout(() => {
                showReconnecting();
                setupHlsPlayer(currentStream);
              }, 5000);
              break;
          }
        }
      });
    } else {
      console.error('[HLS] Not supported in this browser');
      showStreamError('Your browser does not support HLS playback.');
    }
    
    // Setup Media Session for lock screen controls
    setupMediaSession(stream);
    
    // Setup recording capability
    setupRecording(videoElement);
    
    // ==========================================
    // CRITICAL: Play button and volume handlers
    // ==========================================
    const playBtn = document.getElementById('playBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.onclick = () => {
        if (isPlaying) {
          videoElement.pause();
          document.getElementById('playIcon')?.classList.remove('hidden');
          document.getElementById('pauseIcon')?.classList.add('hidden');
          playBtn.classList.remove('playing');
          stopGlobalMeters();
        } else {
          initGlobalAudioAnalyzer(videoElement);
          if (globalAudioContext?.state === 'suspended') {
            globalAudioContext.resume();
          }
          videoElement.play().catch(err => {
            console.error('[HLS] Play error:', err);
            // On mobile, show tap to play message
            if (window.isMobileDevice) {
              showTapToPlay();
            }
          });
          document.getElementById('playIcon')?.classList.add('hidden');
          document.getElementById('pauseIcon')?.classList.remove('hidden');
          playBtn.classList.add('playing');
          startGlobalMeters();
        }
        isPlaying = !isPlaying;
      };
    }
    
    // Volume slider handler
    if (volumeSlider && videoElement) {
      videoElement.volume = volumeSlider.value / 100;
      volumeSlider.oninput = (e) => {
        videoElement.volume = e.target.value / 100;
      };
    }
    
    // Sync play button state with video events
    videoElement.addEventListener('play', () => {
      isPlaying = true;
      document.getElementById('playIcon')?.classList.add('hidden');
      document.getElementById('pauseIcon')?.classList.remove('hidden');
      playBtn?.classList.add('playing');
      updateMiniPlayer(true);
    });
    
    videoElement.addEventListener('pause', () => {
      isPlaying = false;
      document.getElementById('playIcon')?.classList.remove('hidden');
      document.getElementById('pauseIcon')?.classList.add('hidden');
      playBtn?.classList.remove('playing');
      updateMiniPlayer(false);
    });
  }
}

// Show tap to play message for mobile
function showTapToPlay() {
  const videoPlayer = document.getElementById('videoPlayer');
  if (!videoPlayer) return;
  
  const overlay = document.createElement('div');
  overlay.id = 'tapToPlayOverlay';
  overlay.style.cssText = `
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.8);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    z-index: 10;
    cursor: pointer;
  `;
  overlay.innerHTML = `
    <div style="width: 80px; height: 80px; border-radius: 50%; background: #dc2626; display: flex; align-items: center; justify-content: center;">
      <svg viewBox="0 0 24 24" fill="#fff" width="40" height="40"><path d="M8 5v14l11-7z"/></svg>
    </div>
    <span style="color: #fff; font-size: 1.125rem;">Tap to Play</span>
  `;
  
  overlay.onclick = () => {
    const videoElement = document.getElementById('hlsVideoElement');
    if (videoElement) {
      videoElement.play().then(() => {
        overlay.remove();
      }).catch(console.error);
    }
  };
  
  videoPlayer.appendChild(overlay);
}

// Update mini player state
function updateMiniPlayer(playing) {
  const miniPlayIcon = document.getElementById('miniPlayIcon');
  const miniPauseIcon = document.getElementById('miniPauseIcon');
  const miniPlayBtn = document.getElementById('miniPlayBtn');
  
  if (playing) {
    miniPlayIcon?.classList.add('hidden');
    miniPauseIcon?.classList.remove('hidden');
    miniPlayBtn?.classList.add('playing');
  } else {
    miniPlayIcon?.classList.remove('hidden');
    miniPauseIcon?.classList.add('hidden');
    miniPlayBtn?.classList.remove('playing');
  }
}

// Setup Media Session API for lock screen controls
function setupMediaSession(stream) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: stream?.title || 'Live Stream',
      artist: stream?.djName || 'Fresh Wax',
      album: 'Fresh Wax Live',
      artwork: [
        { src: stream?.djAvatar || '/logo.webp', sizes: '96x96', type: 'image/png' },
        { src: stream?.djAvatar || '/logo.webp', sizes: '128x128', type: 'image/png' },
        { src: stream?.djAvatar || '/logo.webp', sizes: '192x192', type: 'image/png' },
        { src: stream?.djAvatar || '/logo.webp', sizes: '256x256', type: 'image/png' },
        { src: stream?.djAvatar || '/logo.webp', sizes: '384x384', type: 'image/png' },
        { src: stream?.djAvatar || '/logo.webp', sizes: '512x512', type: 'image/png' },
      ]
    });
    
    navigator.mediaSession.setActionHandler('play', () => {
      const playBtn = document.getElementById('playBtn');
      if (playBtn && !playBtn.classList.contains('playing')) {
        playBtn.click();
      }
    });
    
    navigator.mediaSession.setActionHandler('pause', () => {
      const playBtn = document.getElementById('playBtn');
      if (playBtn && playBtn.classList.contains('playing')) {
        playBtn.click();
      }
    });
    
    navigator.mediaSession.setActionHandler('stop', () => {
      const playBtn = document.getElementById('playBtn');
      if (playBtn && playBtn.classList.contains('playing')) {
        playBtn.click();
      }
    });
  }
}

// Show reconnecting overlay
function showReconnecting() {
  const videoPlayer = document.getElementById('videoPlayer');
  if (!videoPlayer) return;
  
  const existingOverlay = videoPlayer.querySelector('.reconnect-overlay');
  if (existingOverlay) return;
  
  const overlay = document.createElement('div');
  overlay.className = 'reconnect-overlay';
  overlay.innerHTML = `
    <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.8); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem;">
      <div style="width: 40px; height: 40px; border: 3px solid #333; border-top-color: #dc2626; border-radius: 50%; animation: spin 1s linear infinite;"></div>
      <span style="color: #fff; font-size: 0.9rem;">Reconnecting...</span>
    </div>
  `;
  videoPlayer.appendChild(overlay);
  setTimeout(() => overlay.remove(), 5000);
}

// Show stream error
function showStreamError(message) {
  const videoPlayer = document.getElementById('videoPlayer');
  if (!videoPlayer) return;
  
  videoPlayer.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #1a1a1a; color: #fff; padding: 2rem; text-align: center;">
      <div style="font-size: 3rem; margin-bottom: 1rem;">📡</div>
      <h3 style="margin: 0 0 0.5rem 0; font-size: 1.125rem;">Connecting to Stream...</h3>
      <p style="color: #888; margin: 0; font-size: 0.875rem;">${message}</p>
      <button onclick="location.reload()" style="margin-top: 1rem; padding: 0.75rem 1.5rem; background: #dc2626; border: none; border-radius: 8px; color: #fff; cursor: pointer; font-size: 1rem; -webkit-tap-highlight-color: transparent;">
        Retry
      </button>
    </div>
  `;
}

// ==========================================
// AUDIO ANALYZER FOR LED METERS
// ==========================================
function initGlobalAudioAnalyzer(mediaElement) {
  if (globalAudioContext && globalMediaSource) return;
  
  try {
    globalAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    globalMediaSource = globalAudioContext.createMediaElementSource(mediaElement);
    
    const splitter = globalAudioContext.createChannelSplitter(2);
    
    globalAnalyserLeft = globalAudioContext.createAnalyser();
    globalAnalyserRight = globalAudioContext.createAnalyser();
    globalAnalyserLeft.fftSize = 256;
    globalAnalyserRight.fftSize = 256;
    globalAnalyserLeft.smoothingTimeConstant = 0.5;
    globalAnalyserRight.smoothingTimeConstant = 0.5;
    
    globalMediaSource.connect(splitter);
    splitter.connect(globalAnalyserLeft, 0);
    splitter.connect(globalAnalyserRight, 1);
    globalMediaSource.connect(globalAudioContext.destination);
    
    console.log('[Audio] Analyzer initialized');
  } catch (err) {
    console.error('[Audio] Analyzer error:', err);
  }
}

function updateGlobalMeters() {
  if (!globalAnalyserLeft || !globalAnalyserRight) {
    globalAnimationId = requestAnimationFrame(updateGlobalMeters);
    return;
  }
  
  const leftLeds = document.querySelectorAll('#leftMeter .led');
  const rightLeds = document.querySelectorAll('#rightMeter .led');
  
  if (leftLeds.length === 0 || rightLeds.length === 0) {
    globalAnimationId = requestAnimationFrame(updateGlobalMeters);
    return;
  }
  
  const leftData = new Uint8Array(globalAnalyserLeft.frequencyBinCount);
  const rightData = new Uint8Array(globalAnalyserRight.frequencyBinCount);
  globalAnalyserLeft.getByteFrequencyData(leftData);
  globalAnalyserRight.getByteFrequencyData(rightData);
  
  let leftSum = 0, rightSum = 0;
  for (let i = 0; i < leftData.length; i++) {
    leftSum += leftData[i] * leftData[i];
    rightSum += rightData[i] * rightData[i];
  }
  const leftRms = Math.sqrt(leftSum / leftData.length);
  const rightRms = Math.sqrt(rightSum / rightData.length);
  
  const leftLevel = Math.min(14, Math.floor((leftRms / 255) * 18));
  const rightLevel = Math.min(14, Math.floor((rightRms / 255) * 18));
  
  leftLeds.forEach((led, i) => led.classList.toggle('active', i < leftLevel));
  rightLeds.forEach((led, i) => led.classList.toggle('active', i < rightLevel));
  
  globalAnimationId = requestAnimationFrame(updateGlobalMeters);
}

function stopGlobalMeters() {
  if (globalAnimationId) {
    cancelAnimationFrame(globalAnimationId);
    globalAnimationId = null;
  }
  document.querySelectorAll('.led-strip .led').forEach(led => led.classList.remove('active'));
}

function startGlobalMeters() {
  if (!globalAnimationId) updateGlobalMeters();
}

// ==========================================
// STREAM RECORDING
// ==========================================
function setupRecording(mediaElement) {
  const recordBtn = document.getElementById('recordBtn');
  if (!recordBtn) return;
  
  recordBtn.disabled = false;
  recordBtn.onclick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording(mediaElement);
    }
  };
}

function startRecording(mediaElement) {
  const recordBtn = document.getElementById('recordBtn');
  const recordDuration = document.getElementById('recordDuration');
  
  if (!mediaElement) {
    console.error('[Recording] No media element');
    return;
  }
  
  try {
    let stream;
    if (mediaElement.captureStream) {
      stream = mediaElement.captureStream();
    } else if (mediaElement.mozCaptureStream) {
      stream = mediaElement.mozCaptureStream();
    } else {
      alert('Recording not supported in your browser.');
      return;
    }
    
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      alert('No audio track available.');
      return;
    }
    
    const audioStream = new MediaStream(audioTracks);
    
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/ogg;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      }
    }
    
    const options = mimeType ? { mimeType, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 };
    mediaRecorder = new MediaRecorder(audioStream, options);
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    
    mediaRecorder.onstop = () => downloadRecording();
    mediaRecorder.onerror = () => {
      stopRecording();
      alert('Recording error occurred.');
    };
    
    mediaRecorder.start(1000);
    isRecording = true;
    recordingStartTime = Date.now();
    
    recordBtn?.classList.add('recording');
    const recordText = recordBtn.querySelector('.record-text');
    if (recordText) recordText.textContent = 'STOP';
    recordDuration?.classList.remove('hidden');
    
    recordingInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      if (recordDuration) recordDuration.textContent = `${mins}:${secs}`;
    }, 1000);
    
    console.log('[Recording] Started');
  } catch (err) {
    console.error('[Recording] Failed:', err);
    alert('Failed to start recording.');
  }
}

function stopRecording() {
  const recordBtn = document.getElementById('recordBtn');
  const recordDuration = document.getElementById('recordDuration');
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  isRecording = false;
  
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  
  recordBtn?.classList.remove('recording');
  const recordText = recordBtn?.querySelector('.record-text');
  if (recordText) recordText.textContent = 'REC';
  recordDuration?.classList.add('hidden');
  if (recordDuration) recordDuration.textContent = '00:00';
  
  console.log('[Recording] Stopped');
}

function downloadRecording() {
  if (recordedChunks.length === 0) return;
  
  const blob = new Blob(recordedChunks, { type: recordedChunks[0].type || 'audio/webm' });
  const djName = document.getElementById('djName')?.textContent || 'DJ';
  const streamTitle = document.getElementById('streamTitle')?.textContent || 'Live';
  const date = new Date().toISOString().split('T')[0];
  
  const sanitize = (str) => str.replace(/[^a-zA-Z0-9\s\-\_]/g, '').trim().replace(/\s+/g, '_');
  const filename = `FreshWax_${sanitize(djName)}_${sanitize(streamTitle)}_${date}.webm`;
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  
  recordedChunks = [];
  console.log(`[Recording] Downloaded: ${filename}`);
}

// ==========================================
// TWITCH PLAYER
// ==========================================
function setupTwitchPlayer(stream) {
  document.getElementById('audioPlayer')?.classList.add('hidden');
  document.getElementById('videoPlayer')?.classList.remove('hidden');
  
  const videoElement = document.getElementById('hlsVideoElement');
  const twitchEmbed = document.getElementById('twitchEmbed');
  
  if (videoElement) videoElement.classList.add('hidden');
  if (twitchEmbed) twitchEmbed.classList.remove('hidden');
  
  const parent = window.location.hostname;
  
  if (twitchEmbed) {
    twitchEmbed.innerHTML = `
      <iframe
        src="https://player.twitch.tv/?channel=${stream.twitchChannel}&parent=${parent}&muted=false"
        allowfullscreen
        frameborder="0"
        style="width: 100%; height: 100%;"
      ></iframe>
    `;
  }
}

// ==========================================
// AUDIO PLAYER (Icecast)
// ==========================================
function setupAudioPlayer(stream) {
  document.getElementById('audioPlayer')?.classList.remove('hidden');
  document.getElementById('videoPlayer')?.classList.add('hidden');
  
  const audio = document.getElementById('audioElement');
  const playBtn = document.getElementById('playBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  
  if (stream.audioStreamUrl && audio) {
    audio.src = stream.audioStreamUrl;
  }
  
  if (audio && volumeSlider) {
    audio.volume = volumeSlider.value / 100;
  }
  
  if (playBtn) {
    playBtn.disabled = false;
    playBtn.onclick = () => {
      if (isPlaying) {
        audio?.pause();
        document.getElementById('playIcon')?.classList.remove('hidden');
        document.getElementById('pauseIcon')?.classList.add('hidden');
        playBtn.classList.remove('playing');
        stopGlobalMeters();
      } else {
        initGlobalAudioAnalyzer(audio);
        if (globalAudioContext?.state === 'suspended') {
          globalAudioContext.resume();
        }
        audio?.play().catch(console.error);
        document.getElementById('playIcon')?.classList.add('hidden');
        document.getElementById('pauseIcon')?.classList.remove('hidden');
        playBtn.classList.add('playing');
        startGlobalMeters();
      }
      isPlaying = !isPlaying;
    };
  }
  
  if (volumeSlider && audio) {
    volumeSlider.oninput = (e) => {
      audio.volume = e.target.value / 100;
    };
  }
  
  // Setup Media Session
  setupMediaSession(stream);
  
  // Setup recording
  setupRecording(audio);
}

// ==========================================
// VIEWER SESSION
// ==========================================
async function joinStream(streamId) {
  viewerSessionId = `viewer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    await fetch('/api/livestream/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        streamId,
        userId: currentUser?.uid || null,
        sessionId: viewerSessionId
      })
    });
    
    // Heartbeat every 30 seconds
    setInterval(() => {
      if (currentStream) {
        fetch('/api/livestream/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'heartbeat',
            streamId: currentStream.id,
            sessionId: viewerSessionId
          })
        }).then(res => res.json()).then(data => {
          if (data.success) {
            const viewerCount = document.getElementById('viewerCount');
            const likeCount = document.getElementById('likeCount');
            if (viewerCount) viewerCount.textContent = data.currentViewers;
            if (likeCount) likeCount.textContent = data.totalLikes;
          }
        }).catch(() => {});
      }
    }, 30000);
  } catch (error) {
    console.error('[Viewer] Join error:', error);
  }
  
  // Leave on page unload
  window.addEventListener('beforeunload', () => {
    if (currentStream && viewerSessionId) {
      navigator.sendBeacon('/api/livestream/react', JSON.stringify({
        action: 'leave',
        streamId: currentStream.id,
        sessionId: viewerSessionId
      }));
    }
  });
}

// ==========================================
// CHAT SYSTEM
// ==========================================
function setupChat(streamId) {
  const chatQuery = query(
    collection(db, 'livestream-chat'),
    where('streamId', '==', streamId),
    where('isModerated', '==', false),
    orderBy('createdAt', 'desc'),
    limit(100)
  );
  
  chatUnsubscribe = onSnapshot(chatQuery, (snapshot) => {
    const messages = [];
    let hasNewMessage = false;
    
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') hasNewMessage = true;
    });
    
    snapshot.forEach(doc => {
      messages.push({ id: doc.id, ...doc.data() });
    });
    
    messages.reverse();
    renderChatMessages(messages);
    
    if (hasNewMessage && typeof window.notifyNewChatMessage === 'function') {
      window.notifyNewChatMessage();
    }
  }, (error) => {
    console.warn('[Chat] Error:', error.code);
  });
  
  setupEmojiPicker();
  setupGiphyPicker();
  setupChatInput(streamId);
}

function renderChatMessages(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  
  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
  
  container.innerHTML = `
    <div class="chat-welcome" style="text-align: center; padding: 0.75rem; background: #1a1a2e; border-radius: 8px; margin-bottom: 0.5rem;">
      <p style="color: #a5b4fc; margin: 0; font-size: 0.8125rem;">Welcome! Be respectful 🎵</p>
    </div>
    ${messages.map(msg => {
      const initial = (msg.userName || 'A')[0].toUpperCase();
      
      if (msg.type === 'giphy' && msg.giphyUrl) {
        return `
          <div class="chat-message" style="display: flex; gap: 0.5rem; padding: 0.5rem 0; animation: slideIn 0.2s ease-out;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 0.6875rem; color: #fff; flex-shrink: 0;">${initial}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 600; color: #6366f1; font-size: 0.75rem; margin-bottom: 0.25rem;">${msg.userName}</div>
              <img src="${msg.giphyUrl}" alt="GIF" style="max-width: 150px; border-radius: 6px;" loading="lazy" />
            </div>
          </div>
        `;
      }
      
      return `
        <div class="chat-message" style="display: flex; gap: 0.5rem; padding: 0.5rem 0; animation: slideIn 0.2s ease-out;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 0.6875rem; color: #fff; flex-shrink: 0;">${initial}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; color: #6366f1; font-size: 0.75rem; margin-bottom: 0.125rem;">${msg.userName}</div>
            <div style="color: #fff; font-size: 0.875rem; word-break: break-word; line-height: 1.4;">${escapeHtml(msg.message)}</div>
          </div>
        </div>
      `;
    }).join('')}
  `;
  
  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setupEmojiPicker() {
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPicker = document.getElementById('emojiPicker');
  const emojiGrid = document.getElementById('emojiGrid');
  const giphyPicker = document.getElementById('giphyPicker');
  
  let currentCategory = 'music';
  
  function renderEmojis(category) {
    const emojis = EMOJI_CATEGORIES[category] || [];
    if (emojiGrid) {
      emojiGrid.innerHTML = emojis.map(emoji => 
        `<button style="padding: 0.5rem; background: none; border: none; font-size: 1.25rem; cursor: pointer; border-radius: 6px; -webkit-tap-highlight-color: transparent;" data-emoji="${emoji}">${emoji}</button>`
      ).join('');
      
      emojiGrid.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          const input = document.getElementById('chatInput');
          if (input) input.value += btn.dataset.emoji;
          input?.focus();
        };
      });
    }
  }
  
  document.querySelectorAll('.emoji-cat').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.emoji-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.cat;
      renderEmojis(currentCategory);
    };
  });
  
  if (emojiBtn) {
    emojiBtn.onclick = () => {
      emojiPicker?.classList.toggle('hidden');
      giphyPicker?.classList.add('hidden');
      emojiBtn.classList.toggle('active');
      document.getElementById('giphyBtn')?.classList.remove('active');
      
      if (!emojiPicker?.classList.contains('hidden')) {
        renderEmojis(currentCategory);
      }
    };
  }
}

function setupGiphyPicker() {
  const giphyBtn = document.getElementById('giphyBtn');
  const giphyPicker = document.getElementById('giphyPicker');
  const giphySearch = document.getElementById('giphySearch');
  const giphyGrid = document.getElementById('giphyGrid');
  const emojiPicker = document.getElementById('emojiPicker');
  
  let searchTimeout;
  
  async function searchGiphy(query) {
    if (!GIPHY_API_KEY) {
      if (giphyGrid) giphyGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 1rem;">Giphy not configured</p>';
      return;
    }
    
    try {
      const endpoint = query 
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=20&rating=pg-13`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=20&rating=pg-13`;
      
      const response = await fetch(endpoint);
      const data = await response.json();
      
      if (data.data?.length > 0 && giphyGrid) {
        giphyGrid.innerHTML = data.data.map(gif => `
          <div style="aspect-ratio: 1; border-radius: 6px; overflow: hidden; cursor: pointer; -webkit-tap-highlight-color: transparent;" data-url="${gif.images.fixed_height.url}" data-id="${gif.id}">
            <img src="${gif.images.fixed_height_small.url}" alt="${gif.title}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy" />
          </div>
        `).join('');
        
        giphyGrid.querySelectorAll('div[data-url]').forEach(item => {
          item.onclick = () => {
            sendGiphyMessage(item.dataset.url, item.dataset.id);
            giphyPicker?.classList.add('hidden');
            giphyBtn?.classList.remove('active');
          };
        });
      } else if (giphyGrid) {
        giphyGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 1rem;">No GIFs found</p>';
      }
    } catch (error) {
      console.error('[Giphy] Error:', error);
    }
  }
  
  if (giphySearch) {
    giphySearch.oninput = (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => searchGiphy(e.target.value), 500);
    };
  }
  
  if (giphyBtn) {
    giphyBtn.onclick = () => {
      giphyPicker?.classList.toggle('hidden');
      emojiPicker?.classList.add('hidden');
      giphyBtn.classList.toggle('active');
      document.getElementById('emojiBtn')?.classList.remove('active');
      
      if (!giphyPicker?.classList.contains('hidden')) {
        searchGiphy('');
      }
    };
  }
}

async function sendGiphyMessage(giphyUrl, giphyId) {
  if (!currentUser || !currentStream) return;
  
  try {
    await fetch('/api/livestream/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId: currentStream.id,
        userId: currentUser.uid,
        userName: currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
        message: '[GIF]',
        type: 'giphy',
        giphyUrl,
        giphyId
      })
    });
  } catch (error) {
    console.error('[Chat] GIF error:', error);
  }
}

function setupChatInput(streamId) {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  
  async function sendMessage() {
    if (!currentUser || !input?.value.trim()) return;
    
    const message = input.value.trim();
    input.value = '';
    
    try {
      const response = await fetch('/api/livestream/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId,
          userId: currentUser.uid,
          userName: currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
          message,
          type: 'text'
        })
      });
      
      const result = await response.json();
      if (!result.success) {
        alert(result.error || 'Failed to send');
      }
    } catch (error) {
      console.error('[Chat] Send error:', error);
    }
  }
  
  if (input) {
    input.onkeypress = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
    };
  }
  
  if (sendBtn) {
    sendBtn.onclick = sendMessage;
  }
}

// ==========================================
// REACTIONS
// ==========================================
function setupReactions(streamId) {
  const starBtns = document.querySelectorAll('.star');
  const shareBtn = document.getElementById('shareBtn');
  
  // Star rating
  starBtns.forEach(btn => {
    btn.onmouseenter = () => {
      const rating = parseInt(btn.dataset.rating);
      starBtns.forEach((s, i) => s.classList.toggle('active', i < rating));
    };
    
    btn.onclick = async () => {
      if (!currentUser) {
        alert('Please sign in to rate');
        return;
      }
      
      const rating = parseInt(btn.dataset.rating);
      
      try {
        const response = await fetch('/api/livestream/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'rate',
            streamId,
            userId: currentUser.uid,
            rating
          })
        });
        
        const result = await response.json();
        if (result.success) {
          const avgRating = document.getElementById('avgRating');
          if (avgRating) avgRating.textContent = result.averageRating.toFixed(1);
        }
      } catch (error) {
        console.error('[Reaction] Rating error:', error);
      }
    };
  });
  
  // Share button - uses native share on mobile
  if (shareBtn) {
    shareBtn.onclick = () => {
      const url = window.location.href;
      if (navigator.share) {
        navigator.share({
          title: currentStream?.title || 'Live Stream',
          text: 'Check out this live stream on Fresh Wax!',
          url
        });
      } else {
        navigator.clipboard.writeText(url);
        alert('Link copied!');
      }
    };
  }
  
  if (currentUser) {
    loadUserReactions(streamId);
  }
}

async function loadUserReactions(streamId) {
  if (!currentUser) return;
  
  try {
    const response = await fetch(`/api/livestream/react?streamId=${streamId}&userId=${currentUser.uid}`);
    const result = await response.json();
    
    if (result.success) {
      document.getElementById('likeBtn')?.classList.toggle('liked', result.hasLiked);
      
      if (result.userRating) {
        document.querySelectorAll('.star').forEach((s, i) => {
          s.classList.toggle('active', i < result.userRating);
        });
      }
    }
  } catch (error) {
    console.error('[Reaction] Load error:', error);
  }
}

// ==========================================
// DURATION TIMER
// ==========================================
function startDurationTimer(startedAt) {
  if (!startedAt) return;
  
  function updateDuration() {
    const start = new Date(startedAt);
    const now = new Date();
    const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
    
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;
    
    let duration;
    if (hours > 0) {
      duration = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      duration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    
    const streamDuration = document.getElementById('streamDuration');
    if (streamDuration) streamDuration.textContent = duration;
  }
  
  updateDuration();
  setInterval(updateDuration, 1000);
}

// ==========================================
// AUTH LISTENER
// ==========================================
function setupAuthListener() {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    
    const loginPrompt = document.getElementById('loginPrompt');
    const chatForm = document.getElementById('chatForm');
    
    if (user) {
      loginPrompt?.classList.add('hidden');
      chatForm?.classList.remove('hidden');
      
      if (currentStream) {
        loadUserReactions(currentStream.id);
      }
    } else {
      loginPrompt?.classList.remove('hidden');
      chatForm?.classList.add('hidden');
    }
  });
}

// ==========================================
// CLEANUP HANDLERS
// ==========================================
window.addEventListener('beforeunload', () => {
  if (isRecording) stopRecording();
});

// Close pickers on outside click
document.addEventListener('click', (e) => {
  const emojiPicker = document.getElementById('emojiPicker');
  const giphyPicker = document.getElementById('giphyPicker');
  const emojiBtn = document.getElementById('emojiBtn');
  const giphyBtn = document.getElementById('giphyBtn');
  
  if (!emojiPicker?.contains(e.target) && !emojiBtn?.contains(e.target)) {
    emojiPicker?.classList.add('hidden');
    emojiBtn?.classList.remove('active');
  }
  
  if (!giphyPicker?.contains(e.target) && !giphyBtn?.contains(e.target)) {
    giphyPicker?.classList.add('hidden');
    giphyBtn?.classList.remove('active');
  }
});

// ==========================================
// INITIALIZE
// ==========================================
init();
