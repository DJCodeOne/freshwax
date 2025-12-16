// public/live-stream.js
// Fresh Wax Live Stream - Mobile-First Optimized
// Version: 2.1 - December 2025 - Pusher Chat Integration

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// Pusher for real-time chat (config from window.PUSHER_CONFIG set by Layout.astro)
let pusher = null;
let chatChannel = null;

// Get Pusher config at runtime (not module load time) to ensure window.PUSHER_CONFIG is set
function getPusherConfig() {
  const config = {
    key: window.PUSHER_CONFIG?.key || '',
    cluster: window.PUSHER_CONFIG?.cluster || 'eu'
  };
  console.log('[DEBUG] getPusherConfig called:', {
    hasConfig: !!window.PUSHER_CONFIG,
    keyLength: config.key.length,
    keyPrefix: config.key.substring(0, 8),
    cluster: config.cluster
  });
  return config;
}

// Persistent autoplay: Remember when user has interacted with player
const AUTOPLAY_KEY = 'freshwax_autoplay';
function shouldAutoplay() {
  // Always try autoplay if user has previously played
  return sessionStorage.getItem(AUTOPLAY_KEY) === 'true';
}
function rememberAutoplay() {
  sessionStorage.setItem(AUTOPLAY_KEY, 'true');
}

// ==========================================
// FIREBASE CONFIGURATION
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g",
  authDomain: "freshwax-store.firebaseapp.com",
  projectId: "freshwax-store",
  storageBucket: "freshwax-store.firebasestorage.app",
  messagingSenderId: "675435782973",
  appId: "1:675435782973:web:e8459c2ec4a5f6d683db54"
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
let chatMessages = []; // Store chat messages for Pusher updates

// Recording state
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
  if (streamId && viewerSessionId) {
    sendHeartbeat(streamId);
  }
}

// ==========================================
// STREAM STATUS CHECK
// ==========================================
async function checkLiveStatus() {
  try {
    // Add cache buster to avoid Cloudflare caching stale responses
    const cacheBuster = Date.now();
    const response = await fetch(`/api/livestream/status?_t=${cacheBuster}`);
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

  // Hide all offline states (main page and fullscreen mode)
  document.getElementById('offlineState')?.classList.add('hidden');
  document.getElementById('offlineOverlay')?.classList.add('hidden');
  document.getElementById('fsOfflineOverlay')?.classList.add('hidden');
  document.getElementById('liveState')?.classList.remove('hidden');

  // Update live badge (main page)
  const liveBadge = document.getElementById('liveBadge');
  const liveStatusText = document.getElementById('liveStatusText');
  if (liveBadge) liveBadge.classList.add('is-live');
  if (liveStatusText) liveStatusText.textContent = 'LIVE';

  // Update fullscreen mode live badge
  const fsBadge = document.getElementById('fsLiveBadge');
  const fsStatus = document.getElementById('fsLiveStatus');
  if (fsBadge) fsBadge.classList.add('is-live');
  if (fsStatus) fsStatus.textContent = 'LIVE';
  
  // Update stream info (main page and fullscreen mode)
  const elements = {
    djName: stream.djName,
    streamGenre: stream.genre || 'Jungle / D&B',
    viewerCount: stream.currentViewers || 0,
    likeCount: stream.totalLikes || 0,
    avgRating: (stream.averageRating || 0).toFixed(1),
    streamDescription: stream.description || 'No description',
    audioDjName: stream.djName || 'DJ',
    audioShowTitle: stream.title || 'Live on Fresh Wax',
    // Fullscreen mode elements
    fsStreamTitle: stream.title || 'Live Stream',
    fsDjName: stream.djName || 'DJ'
  };

  Object.entries(elements).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  // Set stream title with proper HTML styling (LIVE white, SESSION red)
  const streamTitleEl = document.getElementById('streamTitle');
  if (streamTitleEl) {
    streamTitleEl.innerHTML = '<span class="title-live">LIVE</span> <span class="title-session">SESSION</span>';
  }

  // Update images (main page)
  const djAvatar = document.getElementById('djAvatar');
  const streamCover = document.getElementById('streamCover');
  const vinylDjAvatar = document.getElementById('vinylDjAvatar');

  if (stream.djAvatar && djAvatar) djAvatar.src = stream.djAvatar;
  if (stream.coverImage && streamCover) streamCover.src = stream.coverImage;
  if (stream.djAvatar && vinylDjAvatar) vinylDjAvatar.src = stream.djAvatar;

  // Update fullscreen mode images
  const fsDjAvatar = document.getElementById('fsDjAvatar');
  if (stream.djAvatar && fsDjAvatar) fsDjAvatar.src = stream.djAvatar;
  
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

    // Add error listener for video element
    videoElement.addEventListener('error', (e) => {
      console.error('[HLS] Video element error:', e);
      console.error('[HLS] Video error code:', videoElement.error?.code);
      console.error('[HLS] Video error message:', videoElement.error?.message);
    });

    // Mobile-specific: Enable inline playback
    videoElement.setAttribute('playsinline', '');
    videoElement.setAttribute('webkit-playsinline', '');

    const nativeHlsSupport = videoElement.canPlayType('application/vnd.apple.mpegurl');

    // Check if HLS is supported natively (Safari/iOS)
    // Only use native if "probably" - "maybe" means browser might not actually support it
    // Chrome returns "maybe" but can't actually play HLS natively
    if (nativeHlsSupport === 'probably') {
      console.log('[HLS] Using native HLS support (probably)');
      videoElement.src = hlsUrl;
      videoElement.addEventListener('loadedmetadata', () => {
        console.log('[HLS] Native: loadedmetadata fired, attempting autoplay');
        const attemptNativeAutoplay = async () => {
          try {
            if (shouldAutoplay()) {
              await videoElement.play();
              isPlaying = true;
              document.getElementById('playIcon')?.classList.add('hidden');
              document.getElementById('pauseIcon')?.classList.remove('hidden');
              document.getElementById('playBtn')?.classList.add('playing');
              console.log('[HLS] Native autoplay successful');
              return;
            }
            // Try muted autoplay
            videoElement.muted = true;
            await videoElement.play();
            isPlaying = true;
            document.getElementById('playIcon')?.classList.add('hidden');
            document.getElementById('pauseIcon')?.classList.remove('hidden');
            document.getElementById('playBtn')?.classList.add('playing');
            setTimeout(() => { videoElement.muted = false; }, 100);
          } catch (err) {
            console.log('[HLS] Native autoplay blocked:', err.name);
          }
        };
        attemptNativeAutoplay();
      });
    }
    // Use HLS.js for other browsers
    else if (window.Hls && Hls.isSupported()) {
      console.log('[HLS] Using HLS.js library');
      if (hlsPlayer) {
        console.log('[HLS] Destroying existing player');
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
        console.log('[HLS] Manifest parsed, attempting autoplay');
        // Always try to autoplay - modern browsers allow muted autoplay
        // If user has previously played, we try with sound
        const attemptAutoplay = async () => {
          try {
            // First try playing with sound if user previously played
            if (shouldAutoplay()) {
              await videoElement.play();
              isPlaying = true;
              document.getElementById('playIcon')?.classList.add('hidden');
              document.getElementById('pauseIcon')?.classList.remove('hidden');
              document.getElementById('playBtn')?.classList.add('playing');
              console.log('[HLS] Autoplay successful with sound');
              return;
            }
            // Otherwise try muted autoplay
            videoElement.muted = true;
            await videoElement.play();
            isPlaying = true;
            document.getElementById('playIcon')?.classList.add('hidden');
            document.getElementById('pauseIcon')?.classList.remove('hidden');
            document.getElementById('playBtn')?.classList.add('playing');
            console.log('[HLS] Muted autoplay successful');
            // Unmute after a brief moment
            setTimeout(() => {
              videoElement.muted = false;
            }, 100);
          } catch (err) {
            console.log('[HLS] Autoplay blocked, waiting for user interaction:', err.name);
            // Autoplay blocked - show play button
            document.getElementById('playBtn')?.classList.remove('playing');
          }
        };
        attemptAutoplay();
      });

      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.error('[HLS] Error:', data.type, data.details);
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
              console.error('[HLS] Fatal error, cannot recover');
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
      console.error('[HLS] Not supported - Hls exists:', !!window.Hls, 'isSupported:', window.Hls ? Hls.isSupported() : false);
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
          // Remember that user wants autoplay for future page visits
          rememberAutoplay();
          initGlobalAudioAnalyzer(videoElement);
          if (globalAudioContext?.state === 'suspended') {
            globalAudioContext.resume();
          }
          videoElement.muted = false; // Ensure unmuted when user explicitly clicks
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
// STREAM RECORDING (Pro Feature)
// ==========================================
function setupRecording(mediaElement) {
  const recordBtn = document.getElementById('recordBtn');
  if (!recordBtn) return;

  // Check if user has Pro subscription
  const isPro = window.userIsPro === true;

  if (!isPro) {
    // Non-Pro users: show locked state
    recordBtn.disabled = true;
    recordBtn.classList.add('pro-locked');
    recordBtn.title = '🔒 Upgrade to Pro to record livestreams';
    recordBtn.onclick = (e) => {
      e.preventDefault();
      // Show upgrade prompt
      const upgrade = confirm('Recording is a Pro feature.\n\nUpgrade to Fresh Wax Pro to record livestreams and download them as audio files.\n\nWould you like to upgrade now?');
      if (upgrade) {
        window.location.href = '/account/dashboard#upgrade';
      }
    };
    return;
  }

  // Pro users: enable recording
  recordBtn.disabled = false;
  recordBtn.classList.remove('pro-locked');
  recordBtn.title = 'Record live stream';
  recordBtn.onclick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording(mediaElement);
    }
  };
}

// MP3 encoder variables
let recordingAudioContext = null;
let recordingSourceNode = null;
let recordingScriptNode = null;
let recordingLeftChannel = [];
let recordingRightChannel = [];
let recordingSampleRate = 44100;

// Load lamejs MP3 encoder
let lameEncoder = null;
async function loadLameEncoder() {
  if (lameEncoder) return lameEncoder;

  return new Promise((resolve) => {
    if (window.lamejs) {
      lameEncoder = window.lamejs;
      resolve(lameEncoder);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    script.onload = () => {
      lameEncoder = window.lamejs;
      console.log('[Recording] Lame encoder loaded');
      resolve(lameEncoder);
    };
    script.onerror = () => {
      console.error('[Recording] Failed to load lame encoder');
      resolve(null);
    };
    document.head.appendChild(script);
  });
}

async function startRecording(mediaElement) {
  const recordBtn = document.getElementById('recordBtn');
  const recordDuration = document.getElementById('recordDuration');

  if (!mediaElement) {
    console.error('[Recording] No media element');
    return;
  }

  // Load MP3 encoder
  await loadLameEncoder();
  if (!lameEncoder) {
    alert('Failed to load MP3 encoder. Recording not available.');
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

    // Create audio context for capturing raw PCM data
    recordingAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    recordingSampleRate = recordingAudioContext.sampleRate;
    recordingSourceNode = recordingAudioContext.createMediaStreamSource(audioStream);

    // Use ScriptProcessor to capture raw audio (deprecated but widely supported)
    const bufferSize = 4096;
    recordingScriptNode = recordingAudioContext.createScriptProcessor(bufferSize, 2, 2);

    // Clear previous recording data
    recordingLeftChannel = [];
    recordingRightChannel = [];

    recordingScriptNode.onaudioprocess = (e) => {
      if (!isRecording) return;

      // Get raw PCM data from both channels
      const leftData = new Float32Array(e.inputBuffer.getChannelData(0));
      const rightData = new Float32Array(e.inputBuffer.getChannelData(1));

      recordingLeftChannel.push(leftData);
      recordingRightChannel.push(rightData);
    };

    recordingSourceNode.connect(recordingScriptNode);
    recordingScriptNode.connect(recordingAudioContext.destination);

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

    console.log('[Recording] Started - capturing at ' + recordingSampleRate + 'Hz');
  } catch (err) {
    console.error('[Recording] Failed:', err);
    alert('Failed to start recording.');
  }
}

function stopRecording() {
  const recordBtn = document.getElementById('recordBtn');
  const recordDuration = document.getElementById('recordDuration');

  const wasRecording = isRecording;
  isRecording = false;

  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }

  // Disconnect audio nodes
  if (recordingScriptNode) {
    recordingScriptNode.disconnect();
    recordingScriptNode = null;
  }
  if (recordingSourceNode) {
    recordingSourceNode.disconnect();
    recordingSourceNode = null;
  }
  if (recordingAudioContext) {
    recordingAudioContext.close();
    recordingAudioContext = null;
  }

  recordBtn?.classList.remove('recording');
  const recordText = recordBtn?.querySelector('.record-text');
  if (recordText) recordText.textContent = 'REC';
  recordDuration?.classList.add('hidden');
  if (recordDuration) recordDuration.textContent = '00:00';

  console.log('[Recording] Stopped');

  // Encode and download if we were recording
  if (wasRecording && recordingLeftChannel.length > 0) {
    encodeAndDownloadMp3();
  }
}

function encodeAndDownloadMp3() {
  if (!lameEncoder || recordingLeftChannel.length === 0) {
    console.log('[Recording] No data to encode');
    recordingLeftChannel = [];
    recordingRightChannel = [];
    return;
  }

  console.log('[Recording] Encoding to MP3...');

  try {
    // Flatten the recorded chunks into single arrays
    const leftLength = recordingLeftChannel.reduce((acc, chunk) => acc + chunk.length, 0);
    const leftBuffer = new Float32Array(leftLength);
    const rightBuffer = new Float32Array(leftLength);

    let offset = 0;
    for (let i = 0; i < recordingLeftChannel.length; i++) {
      leftBuffer.set(recordingLeftChannel[i], offset);
      rightBuffer.set(recordingRightChannel[i], offset);
      offset += recordingLeftChannel[i].length;
    }

    // Convert Float32 to Int16
    const leftInt16 = floatTo16BitPCM(leftBuffer);
    const rightInt16 = floatTo16BitPCM(rightBuffer);

    // Create MP3 encoder at 192kbps stereo
    const mp3encoder = new lameEncoder.Mp3Encoder(2, recordingSampleRate, 192);
    const mp3Data = [];

    // Encode in chunks
    const sampleBlockSize = 1152;
    for (let i = 0; i < leftInt16.length; i += sampleBlockSize) {
      const leftChunk = leftInt16.subarray(i, i + sampleBlockSize);
      const rightChunk = rightInt16.subarray(i, i + sampleBlockSize);
      const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }

    // Flush remaining data
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    // Create blob from MP3 data
    const blob = new Blob(mp3Data, { type: 'audio/mp3' });

    // Generate filename
    const djName = document.getElementById('djName')?.textContent || 'DJ';
    const streamTitle = document.getElementById('streamTitle')?.textContent || 'Live';
    const date = new Date().toISOString().split('T')[0];
    const sanitize = (str) => str.replace(/[^a-zA-Z0-9\s\-\_]/g, '').trim().replace(/\s+/g, '_');
    const filename = `FreshWax_${sanitize(djName)}_${sanitize(streamTitle)}_${date}.mp3`;

    // Download
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

    console.log(`[Recording] Downloaded: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error('[Recording] Encoding failed:', err);
    alert('Failed to encode recording. Please try again.');
  }

  // Clear buffers
  recordingLeftChannel = [];
  recordingRightChannel = [];
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return output;
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
  // Get or create persistent session ID
  if (!sessionStorage.getItem('viewerSessionId')) {
    sessionStorage.setItem('viewerSessionId', `v_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
  }
  viewerSessionId = sessionStorage.getItem('viewerSessionId');
  
  // Send initial heartbeat
  sendHeartbeat(streamId);
  
  // Heartbeat every 30 seconds
  setInterval(() => {
    if (currentStream) {
      sendHeartbeat(currentStream.id);
    }
  }, 30000);
  
  // Leave on page unload
  window.addEventListener('beforeunload', () => {
    if (currentStream && viewerSessionId) {
      navigator.sendBeacon('/api/livestream/heartbeat', JSON.stringify({
        action: 'leave',
        streamId: currentStream.id,
        sessionId: viewerSessionId
      }));
    }
  });
}

async function sendHeartbeat(streamId) {
  try {
    const response = await fetch('/api/livestream/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId,
        sessionId: viewerSessionId
      })
    });
    
    const data = await response.json();
    const count = data.count || 0;
    
    // Update viewer count displays
    const viewerCount = document.getElementById('viewerCount');
    const chatViewers = document.getElementById('chatViewers');
    
    if (viewerCount) {
      viewerCount.textContent = count;
    }
    if (chatViewers) {
      chatViewers.textContent = `${count} watching`;
    }
  } catch (error) {
    console.warn('[Heartbeat] Failed:', error);
  }
}

// ==========================================
// CHAT SYSTEM - Pusher Real-time
// ==========================================
async function setupChat(streamId) {
  console.log('[DEBUG] setupChat called with streamId:', streamId);

  // Load Pusher script if not already loaded
  if (!window.Pusher) {
    console.log('[DEBUG] Pusher not loaded, loading script...');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js.pusher.com/8.2.0/pusher.min.js';
      script.onload = () => {
        console.log('[DEBUG] Pusher script loaded successfully');
        resolve();
      };
      script.onerror = (e) => {
        console.error('[DEBUG] Pusher script failed to load:', e);
        reject(e);
      };
      document.head.appendChild(script);
    });
  } else {
    console.log('[DEBUG] Pusher already loaded');
  }

  // Initialize Pusher with runtime config
  if (!pusher) {
    const pusherConfig = getPusherConfig();
    if (!pusherConfig.key) {
      console.error('[Chat] Pusher key not configured - check window.PUSHER_CONFIG');
      console.error('[DEBUG] window.PUSHER_CONFIG:', window.PUSHER_CONFIG);
      return;
    }
    console.log('[Chat] Initializing Pusher with key:', pusherConfig.key.substring(0, 8) + '...');

    // Enable Pusher logging for debug
    window.Pusher.logToConsole = true;

    pusher = new window.Pusher(pusherConfig.key, {
      cluster: pusherConfig.cluster,
      forceTLS: true
    });

    // Add connection state logging
    pusher.connection.bind('state_change', (states) => {
      console.log('[DEBUG] Pusher state change:', states.previous, '->', states.current);
    });

    pusher.connection.bind('error', (err) => {
      console.error('[DEBUG] Pusher connection error:', err);
    });

    console.log('[DEBUG] Pusher instance created, connection state:', pusher.connection.state);
  } else {
    console.log('[DEBUG] Pusher already initialized, state:', pusher.connection.state);
  }
  
  // Load initial messages via API (20 messages, 20 Firebase reads total)
  try {
    const response = await fetch(`/api/livestream/chat?streamId=${streamId}&limit=20`);
    const result = await response.json();
    if (result.success) {
      chatMessages = result.messages || [];
      renderChatMessages(chatMessages);
    }
  } catch (error) {
    console.warn('[Chat] Failed to load initial messages:', error);
  }
  
  // Subscribe to Pusher channel for real-time updates (no Firebase reads!)
  if (chatChannel) {
    console.log('[DEBUG] Unsubscribing from previous channel:', chatChannel.name);
    chatChannel.unbind_all();
    pusher.unsubscribe(chatChannel.name);
  }

  const channelName = `stream-${streamId}`;
  console.log('[DEBUG] Subscribing to channel:', channelName);
  chatChannel = pusher.subscribe(channelName);

  // Add subscription state logging
  chatChannel.bind('pusher:subscription_succeeded', () => {
    console.log('[DEBUG] Successfully subscribed to channel:', channelName);
  });

  chatChannel.bind('pusher:subscription_error', (error) => {
    console.error('[DEBUG] Channel subscription error:', channelName, error);
  });

  chatChannel.bind('new-message', (message) => {
    console.log('[DEBUG] Received new-message event:', message);
    // Add new message to array
    chatMessages.push(message);
    
    // Keep only last 50 messages in memory
    if (chatMessages.length > 50) {
      chatMessages = chatMessages.slice(-50);
    }
    
    // Re-render
    renderChatMessages(chatMessages);
    
    // Notify mobile tab badge
    if (typeof window.notifyNewChatMessage === 'function') {
      window.notifyNewChatMessage();
    }
  });
  
  // Listen for reactions from other viewers
  chatChannel.bind('reaction', (data) => {
    console.log('[Reaction] Received:', data);
    console.log('[Reaction] Current user:', currentUser?.uid);
    console.log('[Reaction] Data userId:', data.userId);

    // Skip if this is our own reaction (we already showed it locally)
    // Use a session-based check to allow same user on multiple devices
    const reactionSessionId = data.sessionId || data.userId;
    const mySessionId = window.reactionSessionId || currentUser?.uid;

    if (reactionSessionId && mySessionId && reactionSessionId === mySessionId) {
      console.log('[Reaction] Skipping own reaction (same session)');
      return;
    }

    // Display the reaction animation - all reactions are emoji
    const emoji = data.emoji || '❤️';
    const emojiList = emoji.split(',');
    console.log('[Reaction] Displaying emojis:', emojiList);

    // Create burst of emojis in random positions
    const numEmojis = 4 + Math.floor(Math.random() * 4);
    console.log('[Reaction] Creating', numEmojis, 'floating emojis');
    for (let i = 0; i < numEmojis; i++) {
      setTimeout(() => {
        createFloatingEmojiFromBroadcast(emojiList);
      }, i * 70);
    }
  });
  
  // Listen for shoutouts from other viewers
  chatChannel.bind('shoutout', (data) => {
    console.log('[Shoutout] Received:', data);
    if (typeof window.handleIncomingShoutout === 'function') {
      window.handleIncomingShoutout(data);
    }
  });

  // Listen for like count updates
  chatChannel.bind('like-update', (data) => {
    console.log('[Like Update] Received:', data);
    const likeCount = document.getElementById('likeCount');
    if (likeCount && data.totalLikes !== undefined) {
      likeCount.textContent = data.totalLikes;
    }
  });

  // Listen for viewer count updates
  chatChannel.bind('viewer-update', (data) => {
    console.log('[Viewer Update] Received:', data);
    const viewerCount = document.getElementById('viewerCount');
    if (viewerCount && data.currentViewers !== undefined) {
      viewerCount.textContent = data.currentViewers;
    }
  });

  // Make channel available for shoutout sending
  window.pusherChannel = chatChannel;
  
  console.log('[Chat] Pusher connected to stream-' + streamId);
  
  setupEmojiPicker();
  setupGiphyPicker();
  setupChatInput(streamId);
}

function renderChatMessages(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  
  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
  
  // Helper to format time
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  
  container.innerHTML = `
    <div class="chat-welcome" style="text-align: center; padding: 0.75rem; background: #1a1a2e; border-radius: 8px; margin-bottom: 0.5rem;">
      <p style="color: #a5b4fc; margin: 0; font-size: 0.8125rem;">Welcome! Be respectful 🎵</p>
    </div>
    ${messages.map(msg => {
      const time = formatTime(msg.createdAt);
      
      if (msg.type === 'giphy' && msg.giphyUrl) {
        return `
          <div class="chat-message" style="padding: 0.5rem 0; animation: slideIn 0.2s ease-out;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">
              <span style="font-weight: 600; color: #dc2626; font-size: 0.8125rem;">${msg.userName}</span>
              <span style="font-size: 0.6875rem; color: #666;">${time}</span>
            </div>
            <img src="${msg.giphyUrl}" alt="GIF" style="max-width: 150px; border-radius: 6px;" loading="lazy" />
          </div>
        `;
      }
      
      return `
        <div class="chat-message" style="padding: 0.5rem 0; animation: slideIn 0.2s ease-out;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.125rem;">
            <span style="font-weight: 600; color: #dc2626; font-size: 0.8125rem;">${msg.userName}</span>
            <span style="font-size: 0.6875rem; color: #666;">${time}</span>
          </div>
          <div style="color: #fff; font-size: 0.875rem; word-break: break-word; line-height: 1.4;">${escapeHtml(msg.message)}</div>
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
  const shareBtn = document.getElementById('shareBtn');
  
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

// Create floating emoji from broadcast (random position)
function createFloatingEmojiFromBroadcast(emojiList) {
  console.log('[Reaction] createFloatingEmojiFromBroadcast called with:', emojiList);
  const playerArea = document.querySelector('.player-wrapper') || document.querySelector('.player-column');
  let x, y;

  if (playerArea) {
    const rect = playerArea.getBoundingClientRect();
    x = rect.left + Math.random() * rect.width;
    y = rect.top + rect.height * 0.6 + Math.random() * rect.height * 0.3;
    console.log('[Reaction] Player area found, position:', { x, y, rect });
  } else {
    x = window.innerWidth * 0.3 + Math.random() * window.innerWidth * 0.4;
    y = window.innerHeight * 0.4 + Math.random() * window.innerHeight * 0.3;
    console.log('[Reaction] No player area, using window position:', { x, y });
  }
  
  // Create the floating emoji
  const emoji = document.createElement('div');
  emoji.textContent = emojiList[Math.floor(Math.random() * emojiList.length)];
  
  const spreadX = (Math.random() - 0.5) * 60;
  const wiggleAmount = 20 + Math.random() * 30;
  const duration = 2000 + Math.random() * 1000;
  const fontSize = 28 + Math.floor(Math.random() * 20);
  
  Object.assign(emoji.style, {
    position: 'fixed',
    left: (x + spreadX) + 'px',
    top: y + 'px',
    fontSize: fontSize + 'px',
    lineHeight: '1',
    pointerEvents: 'none',
    zIndex: '99999',
    opacity: '1',
    transform: 'scale(0)',
    margin: '0',
    padding: '0'
  });
  
  document.body.appendChild(emoji);
  
  const randomWiggle = Math.random() > 0.5 ? 1 : -1;
  const keyframes = [
    { transform: 'scale(0) rotate(0deg)', opacity: 0.8 },
    { transform: `scale(1.3) translateY(-30px) translateX(${randomWiggle * wiggleAmount * 0.3}px) rotate(${randomWiggle * 15}deg)`, opacity: 1 },
    { transform: `scale(1.1) translateY(-80px) translateX(${randomWiggle * wiggleAmount * 0.6}px) rotate(${randomWiggle * -10}deg)`, opacity: 0.9 },
    { transform: `scale(0.9) translateY(-150px) translateX(${randomWiggle * wiggleAmount}px) rotate(${randomWiggle * 20}deg)`, opacity: 0.6 },
    { transform: `scale(0.7) translateY(-220px) translateX(${randomWiggle * wiggleAmount * 1.2}px) rotate(${randomWiggle * 30}deg)`, opacity: 0 }
  ];
  
  emoji.animate(keyframes, {
    duration: duration,
    easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    fill: 'forwards'
  }).onfinish = () => emoji.remove();
}

async function loadUserReactions(streamId) {
  if (!currentUser) return;
  
  try {
    const response = await fetch(`/api/livestream/react?streamId=${streamId}&userId=${currentUser.uid}`);
    const result = await response.json();
    
    if (result.success) {
      document.getElementById('likeBtn')?.classList.toggle('liked', result.hasLiked);
      
      if (result.userRating) {
        const starBtns = document.querySelectorAll('.star');
        starBtns.forEach((s, i) => {
          s.classList.remove('active', 'user-rated');
          if (i < result.userRating) {
            s.classList.add('active');
          }
          if (i === result.userRating - 1) {
            s.classList.add('user-rated');
          }
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
