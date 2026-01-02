// public/live-stream.js
// Fresh Wax Live Stream - Mobile-First Optimized
// Version: 2.2 - December 2025 - Live status polling + 30s playlist delay

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// Pusher for real-time chat (config from window.PUSHER_CONFIG set by Layout.astro)
let pusher = null;
let chatChannel = null;

// Normalize HLS URLs to use the correct base URL (handles old trycloudflare URLs)
function normalizeHlsUrl(url) {
  if (!url) return url;
  const correctBaseUrl = 'https://stream.freshwax.co.uk';
  // Extract the path after the domain (e.g., /live/stream_key/index.m3u8)
  const match = url.match(/\/live\/[^\/]+\/index\.m3u8$/);
  if (match) {
    return correctBaseUrl + match[0];
  }
  return url;
}

// Playlist manager for media queue when stream is offline
let playlistManager = null;

// Track when stream ended for 30-second delay before resuming playlist
let streamEndedAt = null;
let wasLiveStreamActive = false;
let liveStatusPollInterval = null;

// Emoji/GIF pickers are now handled by inline script in LiveChat.astro

// Register view when entering stream (increments totalViews)
async function registerStreamView(streamId) {
  if (!streamId) return;

  // Generate anonymous ID if not logged in
  const user = auth?.currentUser;
  const userId = user?.uid || 'anon-' + Math.random().toString(36).substr(2, 9);
  const userName = user?.displayName || 'Viewer';

  try {
    const response = await fetch('/api/livestream/listeners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        streamId,
        userId,
        userName,
        avatarUrl: user?.photoURL || null
      })
    });
    const result = await response.json();
    console.log('[View] Registered stream view:', result);

    // Update the view count display with the new totalViews from server
    const viewerCount = document.getElementById('viewerCount');
    if (viewerCount && result.success && result.totalViews) {
      viewerCount.textContent = result.totalViews;
    }
  } catch (e) {
    console.log('[View] Could not register view:', e);
  }
}

// Expose sendGifMessage globally for LiveChat component
window.sendGifMessage = async function(giphyUrl, giphyId) {
  console.log('[GIF] window.sendGifMessage called:', { giphyUrl, giphyId });
  console.log('[GIF] currentUser:', !!currentUser, 'currentStream:', !!currentStream);

  if (!currentUser) {
    console.error('[GIF] No current user - not logged in');
    alert('Please log in to send GIFs');
    return;
  }
  if (!currentStream) {
    console.error('[GIF] No current stream');
    alert('No active stream');
    return;
  }

  try {
    const response = await fetch('/api/livestream/chat', {
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
    console.log('[GIF] Sent successfully:', response.ok);
  } catch (error) {
    console.error('[GIF] Error sending:', error);
  }
};

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
  // Use localStorage for persistence across browser sessions
  // User has previously clicked play, so try with sound
  return localStorage.getItem(AUTOPLAY_KEY) === 'true';
}
function rememberAutoplay() {
  localStorage.setItem(AUTOPLAY_KEY, 'true');
}

// ==========================================
// FIREBASE CONFIGURATION
// Note: Firebase client API keys are safe to be public - they're used for client identification
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

// Expose state globally for LiveChat component
window.liveStreamState = { currentUser: null, currentStream: null };
let viewerSessionId = null;
let isPlaying = false;
let chatMessages = []; // Store chat messages for Pusher updates
let activeUsers = new Map(); // Track active users { odlId -> { id, name, avatar, lastSeen } }
let heartbeatOnlineUsers = []; // Authoritative list from server heartbeat
window.emojiAnimationsEnabled = false; // Only enable when livestream is active

// Expose function to get online viewers for LiveChat sidebar
window.getOnlineViewers = function() {
  // Merge heartbeat users (authoritative) with local chat tracking
  const mergedUsers = new Map();

  // Add users from heartbeat first (authoritative)
  for (const user of heartbeatOnlineUsers) {
    if (user.id && user.id !== 'freshwax-bot') {
      mergedUsers.set(user.id, {
        id: user.id,
        name: user.name || 'User',
        avatar: user.avatar || null
      });
    }
  }

  // Add local tracked users (from chat messages) if not already in heartbeat list
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  activeUsers.forEach((user, id) => {
    if (user.lastSeen > fiveMinutesAgo && id !== 'freshwax-bot' && !mergedUsers.has(id)) {
      mergedUsers.set(id, {
        id: user.id,
        name: user.name,
        avatar: user.avatar
      });
    }
  });

  return Array.from(mergedUsers.values());
};

// Update online users from heartbeat
window.setHeartbeatOnlineUsers = function(users) {
  heartbeatOnlineUsers = users || [];
};

// Track user from chat message
function trackActiveUser(msg) {
  if (!msg.userId || msg.userId === 'freshwax-bot') return;

  activeUsers.set(msg.userId, {
    id: msg.userId,
    name: msg.userName || 'User',
    avatar: msg.userAvatar || null,
    lastSeen: Date.now()
  });

  // Also include current logged-in user
  const currentUser = window.liveStreamState?.currentUser;
  if (currentUser && !activeUsers.has(currentUser.uid)) {
    activeUsers.set(currentUser.uid, {
      id: currentUser.uid,
      name: currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
      avatar: currentUser.photoURL || null,
      lastSeen: Date.now()
    });
  }

  // Update the sidebar if function exists
  if (window.updateOnlineUsers) {
    window.updateOnlineUsers(window.getOnlineViewers());
  }
}

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
  // FIRST: Start fallback timer to hide initializing overlay (ensures it always fades even if API errors)
  // This MUST be first before any code that could throw an error
  try {
    const initOverlay = document.getElementById('initializingOverlay');
    if (initOverlay && !initOverlay.classList.contains('hidden')) {
      console.log('[Init] Setting up overlay fallback timers');
      setTimeout(() => {
        if (initOverlay && !initOverlay.classList.contains('hidden') && !initOverlay.classList.contains('fade-out')) {
          console.log('[Init] Fallback: starting overlay fade');
          initOverlay.classList.add('fade-out');
        }
      }, 5000);
      setTimeout(() => {
        if (initOverlay && !initOverlay.classList.contains('hidden')) {
          console.log('[Init] Fallback: hiding overlay');
          initOverlay.classList.add('hidden');
        }
      }, 10000);
    }
  } catch (e) {
    console.error('[Init] Error setting up overlay timers:', e);
  }

  // Check device type for optimizations
  detectMobileDevice();

  // Get playlist manager from window (set by PlaylistModal.astro)
  getPlaylistManager();

  // Listen for playlist updates to show/hide video player
  setupPlaylistListener();

  // Setup UI controls immediately (don't wait for network)
  setupPlaylistPlayButton();
  setupVolumeSlider();
  setupAuthListener();
  setupMobileFeatures();

  // Start network operations in parallel (non-blocking)
  checkLiveStatus();
  setupLiveStatusPusher();

  // Polling is now a FALLBACK only - Pusher handles real-time updates
  // Poll every 2 minutes when Pusher connected, every 20s if not (saves ~90% Firebase reads)
  if (liveStatusPollInterval) clearInterval(liveStatusPollInterval);
  liveStatusPollInterval = setInterval(async () => {
    // Only poll frequently if Pusher isn't connected
    const pusherConnected = window.statusPusher?.connection?.state === 'connected';
    if (!pusherConnected) {
      await checkLiveStatus();
    }
  }, 20000);

  // Slow fallback poll every 2 minutes even when Pusher is connected (safety net)
  setInterval(async () => {
    await checkLiveStatus();
  }, 120000);

  // Always subscribe to reaction channel for emoji broadcasts
  // This ensures all users can see reactions even without active playlist
  // Use a slight delay to ensure DOM and Pusher config are ready
  setTimeout(() => {
    console.log('[Init] Checking reaction subscription...', {
      isLiveStreamActive: window.isLiveStreamActive,
      currentStreamId: window.currentStreamId,
      emojiAnimationsEnabled: window.emojiAnimationsEnabled
    });

    if (!window.isLiveStreamActive) {
      // Always enable emoji animations when on the live page
      window.emojiAnimationsEnabled = true;

      // Subscribe to playlist-global if not already subscribed to a stream
      if (!window.currentStreamId || window.currentStreamId === 'playlist-global') {
        window.currentStreamId = 'playlist-global';
        setupChat('playlist-global');
        console.log('[Init] Subscribed to playlist-global for reactions');
      } else {
        console.log('[Init] Already subscribed to:', window.currentStreamId);
      }
    } else {
      console.log('[Init] Live stream active, using live stream channel');
    }
  }, 500);
}

// Diagnostic function - run window.debugReactions() in console
window.debugReactions = function() {
  console.log('=== REACTION DEBUG INFO ===');
  console.log('emojiAnimationsEnabled:', window.emojiAnimationsEnabled);
  console.log('currentStreamId:', window.currentStreamId);
  console.log('isLiveStreamActive:', window.isLiveStreamActive);
  console.log('pusher connected:', !!window.Pusher);
  console.log('chatChannel:', window.pusherChannel?.name || 'not subscribed');
  console.log('PUSHER_CONFIG:', window.PUSHER_CONFIG);
  console.log('===========================');
  return 'Check values above';
};

// Named handler for playlist updates (allows removal to prevent duplicates)
function handlePlaylistUpdate(event) {
  const { queue, isPlaying } = event.detail;
  const videoPlayer = document.getElementById('videoPlayer');
  const hlsVideo = document.getElementById('hlsVideoElement');
  const playlistPlayer = document.getElementById('playlistPlayer');
  const offlineOverlay = document.getElementById('offlineOverlay');
  const audioPlayer = document.getElementById('audioPlayer');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');

  console.log('[Playlist] Update received:', { queueLength: queue.length, isPlaying, isLiveStreamActive: window.isLiveStreamActive });

  // Store playlist state globally
  window.isPlaylistActive = queue.length > 0;
  window.isPlaylistPlaying = isPlaying;

  // IMPORTANT: Don't override live stream view with playlist
  if (window.isLiveStreamActive) {
    console.log('[Playlist] Live stream active, ignoring playlist UI update');
    return;
  }

  if (queue.length > 0) {
    // Hide offline overlay and audio player - playlist takes priority (only when no live stream)
    if (offlineOverlay) offlineOverlay.classList.add('hidden');
    if (audioPlayer) audioPlayer.classList.add('hidden');
    if (hlsVideo) hlsVideo.classList.add('hidden');

    // Show video player with playlist content
    if (playlistPlayer) {
      playlistPlayer.classList.remove('hidden');
      playlistPlayer.style.display = 'block';
    }
    if (videoPlayer) {
      videoPlayer.classList.remove('hidden');
      videoPlayer.style.display = 'block';
      videoPlayer.style.opacity = '1';
    }

    // Enable play button for playlist control
    if (playBtn) {
      playBtn.disabled = false;
      // Update play/pause icons based on playlist state
      if (isPlaying) {
        playIcon?.classList.add('hidden');
        pauseIcon?.classList.remove('hidden');
        playBtn.classList.add('playing');
        showPlaylistWave(); // Show sound wave for playlist
      } else {
        playIcon?.classList.remove('hidden');
        pauseIcon?.classList.add('hidden');
        playBtn.classList.remove('playing');
        pausePlaylistWave(); // Pause sound wave when not playing
      }
    }

    // Enable emoji reactions and chat when playlist is active
    window.emojiAnimationsEnabled = true;
    setReactionButtonsEnabled(true);
    setChatEnabled(true);

    // Update live badge to show playlist active state (blue with glow)
    if (!window.isLiveStreamActive) {
      const liveBadge = document.getElementById('liveBadge');
      const liveStatusText = document.getElementById('liveStatusText');
      const fsLiveBadge = document.getElementById('fsLiveBadge');
      const fsLiveStatus = document.getElementById('fsLiveStatus');

      if (liveBadge) {
        liveBadge.classList.remove('is-live', 'is-loading');
        liveBadge.classList.add('is-playlist');
      }
      if (liveStatusText) {
        liveStatusText.textContent = 'PLAYLIST ACTIVE';
      }
      if (fsLiveBadge) {
        fsLiveBadge.classList.remove('is-live', 'is-loading');
        fsLiveBadge.classList.add('is-playlist');
      }
      if (fsLiveStatus) {
        fsLiveStatus.textContent = 'PLAYLIST ACTIVE';
      }
    }

    // Set up global channel for playlist mode reactions (if no livestream)
    // Always set up if not on a livestream, even if currentStreamId was set before
    if (!window.isLiveStreamActive) {
      // Only setup chat if we haven't already for playlist-global
      if (window.currentStreamId !== 'playlist-global') {
        window.currentStreamId = 'playlist-global';
        // Setup chat/Pusher for global reactions
        if (typeof setupChat === 'function') {
          setupChat('playlist-global');
        }
        console.log('[Playlist] Set up global channel for reactions');
      }
    }

    console.log('[Playlist] Showing video player for playlist, emojis enabled');
  } else {
    // No playlist items - hide playlist player
    if (playlistPlayer) playlistPlayer.classList.add('hidden');

    // Show offline overlay if no live stream is active
    if (!window.isLiveStreamActive && offlineOverlay) {
      offlineOverlay.classList.remove('hidden');
    }

    // Disable play button if no playlist and no live stream
    if (playBtn && !window.isLiveStreamActive) {
      playBtn.disabled = true;
      playIcon?.classList.remove('hidden');
      pauseIcon?.classList.add('hidden');
      playBtn.classList.remove('playing');
    }

    // Disable emojis and chat if no live stream either
    if (!window.isLiveStreamActive) {
      window.emojiAnimationsEnabled = false;
      setReactionButtonsEnabled(false);
      setChatEnabled(false);
      // Clear global stream ID if it was set for playlist mode
      if (window.currentStreamId === 'playlist-global') {
        window.currentStreamId = null;
      }

      // Reset live badge to offline state
      const liveBadge = document.getElementById('liveBadge');
      const liveStatusText = document.getElementById('liveStatusText');
      const fsLiveBadge = document.getElementById('fsLiveBadge');
      const fsLiveStatus = document.getElementById('fsLiveStatus');

      if (liveBadge) {
        liveBadge.classList.remove('is-live', 'is-playlist', 'is-loading');
      }
      if (liveStatusText) {
        liveStatusText.textContent = 'OFFLINE';
      }
      if (fsLiveBadge) {
        fsLiveBadge.classList.remove('is-live', 'is-playlist', 'is-loading');
      }
      if (fsLiveStatus) {
        fsLiveStatus.textContent = 'OFFLINE';
      }

      // Update offline overlay text
      const offlineOverlay = document.getElementById('offlineOverlay');
      const offlineIconText = document.getElementById('offlineIconText');
      const offlineMainText = document.getElementById('offlineMainText');
      const offlineSubText = document.getElementById('offlineSubText');

      if (offlineOverlay) {
        offlineOverlay.classList.remove('is-loading');
      }
      if (offlineIconText) {
        offlineIconText.textContent = 'OFFLINE';
      }
      if (offlineMainText) {
        offlineMainText.textContent = 'No one is streaming right now';
      }
      if (offlineSubText) {
        offlineSubText.textContent = 'The playlist will start in a moment';
      }
    }

    console.log('[Playlist] Queue empty, hiding playlist player');
  }
}

// Listen for playlist updates to show video player when items are added
function setupPlaylistListener() {
  // Remove any existing listener to prevent duplicates on View Transitions
  window.removeEventListener('playlistUpdate', handlePlaylistUpdate);
  window.addEventListener('playlistUpdate', handlePlaylistUpdate);
}

// Unified play button handler - handles playlist, HLS, and audio modes
function setupPlaylistPlayButton() {
  const playBtn = document.getElementById('playBtn');
  if (!playBtn) return;

  // Single unified click handler for all modes (like fullpage.astro)
  playBtn.onclick = async () => {
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const videoElement = document.getElementById('hlsVideoElement');
    const audioElement = document.getElementById('audioElement');
    const playlistPlayer = document.getElementById('playlistPlayer');

    console.log('[PlayBtn] Clicked, state:', {
      isLiveStreamActive: window.isLiveStreamActive,
      isPlaylistPlaying: window.isPlaylistPlaying,
      hasPlaylistManager: !!window.playlistManager
    });

    // Check if playlist is visible (playlist mode)
    const playlistVisible = playlistPlayer && !playlistPlayer.classList.contains('hidden');

    // Priority 1: Handle Playlist mode (when no live stream)
    if (playlistVisible && window.playlistManager && !window.isLiveStreamActive) {
      const pm = window.playlistManager;
      const isCurrentlyPlaying = window.isPlaylistPlaying || playBtn.classList.contains('playing');

      try {
        if (isCurrentlyPlaying) {
          await pm.pause();
          window.isPlaylistPlaying = false;
          playIcon?.classList.remove('hidden');
          pauseIcon?.classList.add('hidden');
          playBtn.classList.remove('playing');
          pausePlaylistWave(); // Pause sound wave animation
          console.log('[PlayBtn] Playlist paused');
        } else {
          await pm.resume();
          window.isPlaylistPlaying = true;
          playIcon?.classList.add('hidden');
          pauseIcon?.classList.remove('hidden');
          playBtn.classList.add('playing');
          showPlaylistWave(); // Show and animate sound wave
          console.log('[PlayBtn] Playlist resumed');
        }
      } catch (error) {
        console.error('[PlayBtn] Playlist error:', error);
      }
      return;
    }

    // Priority 2: Handle HLS video stream
    if (videoElement && !videoElement.classList.contains('hidden') && window.isLiveStreamActive) {
      if (videoElement.paused) {
        rememberAutoplay();
        initGlobalAudioAnalyzer(videoElement);
        if (globalAudioContext?.state === 'suspended') {
          globalAudioContext.resume();
        }
        videoElement.muted = false;
        try {
          await videoElement.play();
          // State updated by 'play' event listener
        } catch (err) {
          console.error('[PlayBtn] HLS play error:', err);
        }
      } else {
        videoElement.pause();
        // State updated by 'pause' event listener
      }
      return;
    }

    // Priority 3: Handle audio stream (Icecast/relay)
    if (audioElement && window.isLiveStreamActive) {
      if (audioElement.paused) {
        rememberAutoplay();
        initGlobalAudioAnalyzer(audioElement);
        if (globalAudioContext?.state === 'suspended') {
          globalAudioContext.resume();
        }
        audioElement.muted = false;
        try {
          await audioElement.play();
          playIcon?.classList.add('hidden');
          pauseIcon?.classList.remove('hidden');
          playBtn.classList.add('playing');
          startGlobalMeters();
          console.log('[PlayBtn] Audio stream playing');
        } catch (err) {
          console.error('[PlayBtn] Audio play error:', err);
        }
      } else {
        audioElement.pause();
        playIcon?.classList.remove('hidden');
        pauseIcon?.classList.add('hidden');
        playBtn.classList.remove('playing');
        stopGlobalMeters();
        console.log('[PlayBtn] Audio stream paused');
      }
      return;
    }
  };

  console.log('[PlayBtn] Unified handler set up');
}

// Set up volume slider for playlist mode (runs on init, before HLS might set its own handler)
function setupVolumeSlider() {
  const volumeSlider = document.getElementById('volumeSlider');
  if (!volumeSlider) {
    console.log('[Volume] Slider not found');
    return;
  }

  // Add input handler that works for both playlist and HLS
  volumeSlider.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value);
    console.log('[Volume] Slider changed to:', volume);

    // Update HLS video if exists
    const hlsVideo = document.getElementById('hlsVideoElement');
    if (hlsVideo) {
      hlsVideo.volume = volume / 100;
      console.log('[Volume] HLS video volume set to:', volume / 100);
    }

    // Update audio element if exists
    const audio = document.getElementById('audioElement');
    if (audio) {
      audio.volume = volume / 100;
      console.log('[Volume] Audio element volume set to:', volume / 100);
    }

    // Update playlist volume if active
    if (window.playlistManager) {
      console.log('[Volume] Setting playlist manager volume to:', volume);
      window.playlistManager.setVolume(volume);
    } else {
      console.log('[Volume] No playlist manager available');
    }

    // Also try to set embed player volume directly
    if (window.embedPlayerManager) {
      console.log('[Volume] Setting embed player volume to:', volume);
      window.embedPlayerManager.setVolume(volume);
    }
  });

  console.log('[Volume] Slider control set up');
}

// Get playlist manager from window (initialized by PlaylistModal.astro)
function getPlaylistManager() {
  // PlaylistModal.astro initializes and exposes the manager to window
  playlistManager = window.playlistManager || null;

  if (playlistManager) {
    console.log('[Playlist] Using manager from PlaylistModal');
    // Sync volume slider with playlist manager
    const volumeSlider = document.getElementById('volumeSlider');
    if (volumeSlider) {
      playlistManager.setVolume(parseInt(volumeSlider.value));
    }
  } else {
    console.log('[Playlist] Manager not yet available, will retry later');
  }

  return playlistManager;
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
// LIVE STATUS VIA PUSHER (instant updates)
// ==========================================
let liveStatusChannel = null;

async function setupLiveStatusPusher() {
  try {
    // Wait for Pusher to be available
    const config = window.PUSHER_CONFIG;
    if (!config?.key) {
      console.log('[LiveStatus] Pusher config not ready, will rely on polling');
      return;
    }

    // Load Pusher script if not already loaded
    if (!window.Pusher) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://js.pusher.com/8.2.0/pusher.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    // Use existing Pusher instance or create new one
    if (!window.statusPusher) {
      window.statusPusher = new window.Pusher(config.key, {
        cluster: config.cluster,
        forceTLS: true
      });
    }

    // Subscribe to global live status channel
    if (liveStatusChannel) {
      liveStatusChannel.unbind_all();
      window.statusPusher.unsubscribe('live-status');
    }

    liveStatusChannel = window.statusPusher.subscribe('live-status');

    liveStatusChannel.bind('stream-started', (data) => {
      console.log('[LiveStatus] DJ went live via Pusher:', data.djName);
      // Immediately check status to switch to live stream
      checkLiveStatus();
    });

    liveStatusChannel.bind('stream-ended', (data) => {
      console.log('[LiveStatus] Stream ended via Pusher:', data.djName);
      // Trigger the 30-second delay countdown
      wasLiveStreamActive = true;
      streamEndedAt = Date.now();
      checkLiveStatus();
    });

    console.log('[LiveStatus] Subscribed to Pusher live-status channel');
  } catch (err) {
    console.warn('[LiveStatus] Pusher setup failed, falling back to polling:', err);
  }
}

// ==========================================
// STREAM STATUS CHECK
// ==========================================
async function checkLiveStatus() {
  try {
    // Refresh playlist manager reference (in case it wasn't ready during init)
    if (!playlistManager) {
      getPlaylistManager();
    }

    // Add cache buster to avoid Cloudflare caching stale responses
    const cacheBuster = Date.now();
    const response = await fetch(`/api/livestream/status?_t=${cacheBuster}`);
    const result = await response.json();

    console.log('[checkLiveStatus] API response:', {
      success: result.success,
      isLive: result.isLive,
      primaryStream: result.primaryStream ? {
        djName: result.primaryStream.djName,
        broadcastMode: result.primaryStream.broadcastMode,
        hlsUrl: result.primaryStream.hlsUrl,
        audioStreamUrl: result.primaryStream.audioStreamUrl,
        streamSource: result.primaryStream.streamSource
      } : null
    });

    if (result.success && result.isLive && result.primaryStream) {
      // LIVE STREAM ACTIVE - Track state and pause playlist
      wasLiveStreamActive = true;
      streamEndedAt = null; // Clear any previous end time

      if (playlistManager?.isPlaying) {
        await playlistManager.pause();
        playlistManager.wasPausedForStream = true;
        console.log('[Playlist] Paused for live stream');
      }

      // Switch to live stream view - hide playlist first
      const playlistPlayer = document.getElementById('playlistPlayer');
      if (playlistPlayer) playlistPlayer.classList.add('hidden');

      // Let showLiveStream handle showing the correct player (video or audio)
      showLiveStream(result.primaryStream);
    } else {
      // NO LIVE STREAM
      // Track when stream ended (for 10-second delay before resuming playlist)
      if (wasLiveStreamActive && !streamEndedAt) {
        streamEndedAt = Date.now();
        console.log('[Stream] Stream ended, waiting 10 seconds before resuming playlist...');
      }

      // Only resume playlist after 10-second delay (gives time for DJ handoffs)
      const secondsSinceEnd = streamEndedAt ? (Date.now() - streamEndedAt) / 1000 : 999;
      const canResumePlaylist = secondsSinceEnd >= 10;

      if (canResumePlaylist) {
        // Reset tracking flags
        wasLiveStreamActive = false;
        streamEndedAt = null;

        // Resume playlist if it was playing
        if (playlistManager?.wasPausedForStream && playlistManager.queue.length > 0) {
          await playlistManager.resume();
          playlistManager.wasPausedForStream = false;
          console.log('[Playlist] Resumed after 10-second delay');
        }
      } else if (streamEndedAt) {
        console.log(`[Stream] Waiting... ${Math.ceil(10 - secondsSinceEnd)}s until playlist resumes`);
      }

      // Show playlist in main player if queue has items (only after 10s delay)
      const videoPlayer = document.getElementById('videoPlayer');
      const hlsVideo = document.getElementById('hlsVideoElement');
      const playlistPlayer = document.getElementById('playlistPlayer');

      if (canResumePlaylist) {
        if (playlistManager?.queue.length > 0) {
          // Show video player container with playlist content
          if (hlsVideo) hlsVideo.classList.add('hidden');
          if (playlistPlayer) playlistPlayer.classList.remove('hidden');
          if (videoPlayer) {
            videoPlayer.classList.remove('hidden');
            videoPlayer.style.opacity = '1';
          }
        } else {
          // Queue is empty - try to auto-start playlist from history
          if (playlistManager && typeof playlistManager.startAutoPlay === 'function') {
            console.log('[Playlist] No live stream and queue empty - attempting auto-play from history');
            const started = await playlistManager.startAutoPlay();
            if (started) {
              console.log('[Playlist] Auto-play started successfully');
              // Show video player for auto-play content
              if (hlsVideo) hlsVideo.classList.add('hidden');
              if (playlistPlayer) playlistPlayer.classList.remove('hidden');
              if (videoPlayer) {
                videoPlayer.classList.remove('hidden');
                videoPlayer.style.opacity = '1';
              }
            } else {
              // No history available - hide video container
              if (videoPlayer) {
                videoPlayer.style.opacity = '0';
                setTimeout(() => videoPlayer.classList.add('hidden'), 300);
              }
            }
          } else {
            // No playlist manager - hide video container
            if (videoPlayer) {
              videoPlayer.style.opacity = '0';
              setTimeout(() => videoPlayer.classList.add('hidden'), 300);
            }
          }
        }
      } else {
        // Still in 30-second delay - keep showing offline/waiting state
        // Don't switch to playlist yet
        if (hlsVideo) hlsVideo.classList.remove('hidden');
        if (playlistPlayer) playlistPlayer.classList.add('hidden');
      }

      showOfflineState(result.scheduled || []);
    }
  } catch (error) {
    console.error('Error checking live status:', error);
    showOfflineState([]);
  }
}

// Expose checkLiveStatus globally so Pusher handlers can trigger it
window.checkLiveStatus = checkLiveStatus;

// Enable/disable reaction buttons based on stream status
function setReactionButtonsEnabled(enabled) {
  const reactionButtons = document.querySelectorAll('.reaction-btn, .anim-toggle-btn, .fs-reaction-btn, #animToggleBtn, #fsAnimToggleBtn');
  reactionButtons.forEach(btn => {
    if (enabled) {
      btn.classList.remove('reactions-disabled');
      btn.disabled = false;
    } else {
      btn.classList.add('reactions-disabled');
      btn.disabled = true;
    }
  });
  console.log('[Reactions] Buttons ' + (enabled ? 'enabled' : 'disabled'));
}

// Enable/disable chat input
function setChatEnabled(enabled) {
  const chatInput = document.getElementById('chatInput');
  const chatSend = document.getElementById('sendChat');
  const loginPrompt = document.getElementById('loginPrompt');

  if (chatInput) {
    chatInput.disabled = !enabled;
    chatInput.placeholder = enabled ? 'Type a message...' : 'Chat available when stream is live...';
  }
  if (chatSend) {
    chatSend.disabled = !enabled;
  }
  if (loginPrompt) {
    loginPrompt.style.display = enabled ? 'none' : '';
  }
  console.log('[Chat] Input ' + (enabled ? 'enabled' : 'disabled'));
}

// Show offline state
function showOfflineState(scheduled) {
  window.isLiveStreamActive = false;

  // Hide initializing overlay since there's no live stream
  const initOverlay = document.getElementById('initializingOverlay');
  if (initOverlay) {
    initOverlay.classList.add('hidden');
  }

  // Remove loading state from badges and overlays
  const liveBadge = document.getElementById('liveBadge');
  const liveStatusText = document.getElementById('liveStatusText');
  const offlineOverlay = document.getElementById('offlineOverlay');
  const offlineIconText = document.getElementById('offlineIconText');
  const offlineMainText = document.getElementById('offlineMainText');
  const offlineSubText = document.getElementById('offlineSubText');

  if (liveBadge) {
    liveBadge.classList.remove('is-loading', 'is-live');
  }
  if (liveStatusText) {
    liveStatusText.textContent = 'OFFLINE';
  }
  if (offlineOverlay) {
    offlineOverlay.classList.remove('is-loading');
  }
  if (offlineIconText) {
    offlineIconText.textContent = 'OFFLINE';
  }
  if (offlineMainText) {
    offlineMainText.textContent = 'No one is streaming right now';
  }
  if (offlineSubText) {
    offlineSubText.textContent = 'The playlist will start in a moment';
  }

  // Only disable emojis and chat if playlist is also not playing
  const pm = window.playlistManager;
  const isPlaylistPlaying = pm && pm.isPlaying && pm.queue.length > 0;
  if (!isPlaylistPlaying) {
    window.emojiAnimationsEnabled = false;
    setReactionButtonsEnabled(false);
    setChatEnabled(false);
  }

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
  window.isLiveStreamActive = true;
  window.liveStreamState.currentStream = stream; // Expose for LiveChat
  window.emojiAnimationsEnabled = true; // Enable emoji animations when live
  setReactionButtonsEnabled(true); // Enable reaction buttons
  setChatEnabled(true); // Enable chat when live
  hidePlaylistWave(); // Hide sound wave
  showLiveMeters(); // Show LED meters for live stream

  // Expose stream ID globally for reaction buttons
  window.currentStreamId = stream.id;
  window.firebaseAuth = auth;

  // Register view (increments totalViews counter)
  registerStreamView(stream.id);

  // Hide all offline states (main page and fullscreen mode)
  document.getElementById('offlineState')?.classList.add('hidden');
  const offlineOverlay = document.getElementById('offlineOverlay');
  if (offlineOverlay) {
    offlineOverlay.classList.remove('is-loading');
    offlineOverlay.classList.add('hidden');
  }
  document.getElementById('fsOfflineOverlay')?.classList.add('hidden');
  document.getElementById('liveState')?.classList.remove('hidden');

  // Start timers to fade/hide initializing overlay (it's visible by default on page load)
  const initOverlay = document.getElementById('initializingOverlay');
  if (initOverlay && !initOverlay.classList.contains('hidden')) {
    // Start fade out after 5 seconds
    setTimeout(() => {
      if (!initOverlay.classList.contains('hidden')) {
        initOverlay.classList.add('fade-out');
      }
    }, 5000);

    // Fully hide after 10 seconds (fade completes)
    setTimeout(() => {
      initOverlay.classList.add('hidden');
    }, 10000);
  }

  // Update live badge (main page) - remove loading, add live
  const liveBadge = document.getElementById('liveBadge');
  const liveStatusText = document.getElementById('liveStatusText');
  if (liveBadge) {
    liveBadge.classList.remove('is-loading');
    liveBadge.classList.add('is-live');
  }
  if (liveStatusText) liveStatusText.textContent = 'LIVE';

  // Update fullscreen mode live badge - remove loading, add live
  const fsBadge = document.getElementById('fsLiveBadge');
  const fsStatus = document.getElementById('fsLiveStatus');
  if (fsBadge) {
    fsBadge.classList.remove('is-loading');
    fsBadge.classList.add('is-live');
  }
  if (fsStatus) fsStatus.textContent = 'LIVE';

  // Add is-live class to bottom DJ info bar
  const djInfoBar = document.querySelector('.dj-info-bar');
  if (djInfoBar) djInfoBar.classList.add('is-live');

  // Update stream info (main page and fullscreen mode)
  const elements = {
    djName: stream.djName,
    controlsDjName: stream.djName || 'DJ', // Bottom bar DJ name
    streamGenre: stream.genre || 'Jungle / D&B',
    viewerCount: stream.totalViews || stream.currentViewers || 0,
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
    if (stream.isRelay && stream.relaySource?.stationName) {
      // Show relay attribution
      streamTitleEl.innerHTML = `<span class="title-live">RELAY</span> <span class="title-relay-from">from ${stream.relaySource.stationName}</span>`;
    } else {
      streamTitleEl.innerHTML = '<span class="title-live">LIVE</span> <span class="title-session">SESSION</span>';
    }
  }

  // Update images (main page)
  const djAvatar = document.getElementById('djAvatar');
  const streamCover = document.getElementById('streamCover');
  const vinylDjAvatar = document.getElementById('vinylDjAvatar');
  const vinylDjAvatar2 = document.getElementById('vinylDjAvatar2');

  if (stream.djAvatar && djAvatar) djAvatar.src = stream.djAvatar;
  if (stream.coverImage && streamCover) streamCover.src = stream.coverImage;
  if (stream.djAvatar && vinylDjAvatar) vinylDjAvatar.src = stream.djAvatar;
  if (stream.djAvatar && vinylDjAvatar2) vinylDjAvatar2.src = stream.djAvatar;

  // Update fullscreen mode images
  const fsDjAvatar = document.getElementById('fsDjAvatar');
  if (stream.djAvatar && fsDjAvatar) fsDjAvatar.src = stream.djAvatar;
  
  // Setup player based on stream type/source
  // Placeholder mode = audio only (BUTT/Icecast), skip HLS
  const isPlaceholder = stream.broadcastMode === 'placeholder' || stream.broadcastMode === 'audio';

  console.log('[Stream] Player selection:', {
    broadcastMode: stream.broadcastMode,
    isPlaceholder,
    streamSource: stream.streamSource,
    hlsUrl: stream.hlsUrl,
    audioStreamUrl: stream.audioStreamUrl,
    twitchChannel: stream.twitchChannel
  });

  if (stream.streamSource === 'twitch' && stream.twitchChannel) {
    console.log('[Stream] Using Twitch player');
    setupTwitchPlayer(stream);
  } else if (!isPlaceholder && (stream.streamSource === 'red5' || stream.hlsUrl)) {
    console.log('[Stream] Using HLS player');
    setupHlsPlayer(stream);
  } else {
    // Audio mode - use Icecast or relay source
    console.log('[Stream] Using Audio/Icecast player');
    if (stream.isRelay && stream.relaySource?.url) {
      // Relay from external station
      console.log('[Stream] Using relay source:', stream.relaySource.stationName);
      stream.audioStreamUrl = stream.relaySource.url;
    } else if (!stream.audioStreamUrl) {
      stream.audioStreamUrl = 'https://icecast.freshwax.co.uk/live';
    }
    setupAudioPlayer(stream);
  }

  // Setup Twitch chat in fullscreen mode if DJ has Twitch channel
  const twitchChannel = stream.twitchChannel || stream.twitchUsername;
  if (window.setupFsTwitchChat) {
    window.setupFsTwitchChat(twitchChannel);
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
  
  // Normalize to correct base URL (fixes old trycloudflare.com URLs)
  const rawHlsUrl = stream.hlsUrl || stream.videoStreamUrl;
  const hlsUrl = normalizeHlsUrl(rawHlsUrl);

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
        // Fast start settings - reduced initial buffer for quicker connection
        maxBufferLength: window.isMobileDevice ? 10 : 15,
        maxMaxBufferLength: window.isMobileDevice ? 30 : 60,
        maxBufferSize: 30 * 1000 * 1000, // 30MB max buffer
        maxBufferHole: 0.5,
        // Live sync - start from live edge quickly
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        liveDurationInfinity: true,
        liveBackBufferLength: 30,
        // Faster initial manifest parsing
        initialLiveManifestSize: 1,
        // Start from live edge
        startPosition: -1,
        // Aggressive loading for faster start
        startFragPrefetch: true,
        testBandwidth: false,
        // Stall recovery - auto-recover from buffer stalls
        highBufferWatchdogPeriod: 1,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 5,
        // Fragment loading - faster retries
        fragLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 500,
        fragLoadingMaxRetryTimeout: 20000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 500,
        manifestLoadingMaxRetryTimeout: 15000,
        levelLoadingMaxRetry: 3,
        levelLoadingRetryDelay: 500,
        levelLoadingMaxRetryTimeout: 15000
      });

      hlsPlayer.loadSource(hlsUrl);
      hlsPlayer.attachMedia(videoElement);

      // Log when fragments start loading for debugging
      hlsPlayer.on(Hls.Events.FRAG_LOADING, () => {
        console.log('[HLS] Fragment loading...');
      });

      hlsPlayer.on(Hls.Events.FRAG_LOADED, () => {
        console.log('[HLS] Fragment loaded');
      });

      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[HLS] Manifest parsed, attempting autoplay');
        // Try muted autoplay first (faster, less likely to be blocked), then unmute
        const attemptAutoplay = async () => {
          try {
            // First try muted (guaranteed to work)
            videoElement.muted = true;
            await videoElement.play();
            isPlaying = true;
            document.getElementById('playIcon')?.classList.add('hidden');
            document.getElementById('pauseIcon')?.classList.remove('hidden');
            document.getElementById('playBtn')?.classList.add('playing');
            console.log('[HLS] Muted autoplay successful');

            // Now try to unmute (user may have interacted before)
            try {
              videoElement.muted = false;
              console.log('[HLS] Unmuted successfully');
            } catch (unmuteErr) {
              console.log('[HLS] Could not unmute, user interaction required');
            }

            rememberAutoplay();
            // Initialize audio analyzer for LED meters
            initGlobalAudioAnalyzer(videoElement);
            startGlobalMeters();
          } catch (err) {
            console.log('[HLS] Autoplay blocked, showing play button:', err.name);
            // Autoplay blocked - show play button for user to click
            document.getElementById('playIcon')?.classList.remove('hidden');
            document.getElementById('pauseIcon')?.classList.add('hidden');
            document.getElementById('playBtn')?.classList.remove('playing');
          }
        };
        attemptAutoplay();
      });

      // Track retry attempts to prevent infinite loops
      let networkRetryCount = 0;
      const MAX_NETWORK_RETRIES = 3;

      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.error('[HLS] Error:', data.type, data.details);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              networkRetryCount++;
              if (networkRetryCount <= MAX_NETWORK_RETRIES) {
                console.log(`[HLS] Network error, recovering... (attempt ${networkRetryCount}/${MAX_NETWORK_RETRIES})`);
                hlsPlayer.startLoad();
                setTimeout(() => {
                  if (!isPlaying) {
                    showReconnecting();
                    hlsPlayer.loadSource(hlsUrl);
                  }
                }, 1000); // Faster retry - 1 second
              } else {
                console.log('[HLS] Max retries reached, stream appears to be offline');
                hlsPlayer.destroy();
                showStreamError('Stream is offline or unavailable.');
                // Show offline overlay
                document.getElementById('offlineOverlay')?.classList.remove('hidden');
              }
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
              }, 2000); // Faster retry - 2 seconds
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

    // Just enable the button - unified handler in setupPlaylistPlayButton() handles all modes
    if (playBtn) {
      playBtn.disabled = false;
    }
    
    // Volume slider handler - controls both HLS video and playlist
    if (volumeSlider) {
      if (videoElement) {
        videoElement.volume = volumeSlider.value / 100;
      }
      volumeSlider.oninput = (e) => {
        const volume = e.target.value;
        // Update HLS video volume
        if (videoElement) {
          videoElement.volume = volume / 100;
        }
        // Update playlist volume if active
        if (window.playlistManager) {
          window.playlistManager.setVolume(parseInt(volume));
        }
      };
    }
    
    // Sync play button state with video events
    videoElement.addEventListener('play', () => {
      isPlaying = true;
      document.getElementById('playIcon')?.classList.add('hidden');
      document.getElementById('pauseIcon')?.classList.remove('hidden');
      playBtn?.classList.add('playing');
      updateMiniPlayer(true);
      // Re-enable emojis and meters when playing
      window.emojiAnimationsEnabled = true;
      setReactionButtonsEnabled(true);
      startGlobalMeters();
    });

    videoElement.addEventListener('pause', () => {
      isPlaying = false;
      document.getElementById('playIcon')?.classList.remove('hidden');
      document.getElementById('pauseIcon')?.classList.add('hidden');
      playBtn?.classList.remove('playing');
      updateMiniPlayer(false);
      // Disable emojis and meters when paused
      window.emojiAnimationsEnabled = false;
      setReactionButtonsEnabled(false);
      stopGlobalMeters();
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

// Switch to LED meters visualization (for live stream)
function showLiveMeters() {
  const metersWrapper = document.getElementById('stereoMetersWrapper');
  const waveWrapper = document.getElementById('soundWaveWrapper');
  if (metersWrapper) metersWrapper.classList.remove('hidden');
  if (waveWrapper) waveWrapper.classList.add('hidden');
  startGlobalMeters();
}

// Hide LED meters (for playlist mode)
function hideLiveMeters() {
  const metersWrapper = document.getElementById('stereoMetersWrapper');
  if (metersWrapper) metersWrapper.classList.add('hidden');
  stopGlobalMeters();
}

// Switch to sound wave visualization (for playlist)
function showPlaylistWave() {
  const metersWrapper = document.getElementById('stereoMetersWrapper');
  const waveWrapper = document.getElementById('soundWaveWrapper');
  // Hide LED meters completely
  if (metersWrapper) metersWrapper.classList.add('hidden');
  stopGlobalMeters();
  // Show and animate wave
  if (waveWrapper) {
    waveWrapper.classList.remove('hidden');
    waveWrapper.classList.remove('paused');
  }
}

// Pause sound wave animation
function pausePlaylistWave() {
  const waveWrapper = document.getElementById('soundWaveWrapper');
  if (waveWrapper) waveWrapper.classList.add('paused');
}

// Resume sound wave animation
function resumePlaylistWave() {
  const waveWrapper = document.getElementById('soundWaveWrapper');
  if (waveWrapper) waveWrapper.classList.remove('paused');
}

// Hide sound wave (for live stream mode)
function hidePlaylistWave() {
  const waveWrapper = document.getElementById('soundWaveWrapper');
  if (waveWrapper) waveWrapper.classList.add('hidden');
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
  console.log('[Audio] setupAudioPlayer called with stream:', {
    audioStreamUrl: stream.audioStreamUrl,
    hlsUrl: stream.hlsUrl,
    broadcastMode: stream.broadcastMode
  });

  document.getElementById('audioPlayer')?.classList.remove('hidden');
  document.getElementById('videoPlayer')?.classList.add('hidden');

  const audio = document.getElementById('audioElement');
  const playBtn = document.getElementById('playBtn');
  const volumeSlider = document.getElementById('volumeSlider');

  console.log('[Audio] Audio element found:', !!audio, 'playBtn:', !!playBtn);

  if (stream.audioStreamUrl && audio) {
    console.log('[Audio] Setting audio src to:', stream.audioStreamUrl);
    audio.src = stream.audioStreamUrl;
    audio.load();
    console.log('[Audio] Audio loaded, readyState:', audio.readyState);

    // Add event listeners for debugging
    audio.oncanplay = () => console.log('[Audio] canplay event - readyState:', audio.readyState);
    audio.onerror = (e) => console.error('[Audio] ERROR:', audio.error?.code, audio.error?.message);
    audio.onplaying = () => console.log('[Audio] playing event - audio is now playing');
    audio.onpause = () => console.log('[Audio] pause event');
    audio.onstalled = () => console.log('[Audio] stalled event - download stalled');
    audio.onwaiting = () => console.log('[Audio] waiting event - buffering');

    // Try autoplay (muted first for browser policy, then unmute)
    const attemptAutoplay = async () => {
      console.log('[Audio] Attempting autoplay...');
      try {
        audio.muted = true;
        console.log('[Audio] Audio muted, calling play()...');
        await audio.play();
        console.log('[Audio] Muted autoplay successful, readyState:', audio.readyState);
        isPlaying = true;

        // Try to unmute
        try {
          audio.muted = false;
          console.log('[Audio] Unmuted successfully, volume:', audio.volume);
        } catch (e) {
          console.log('[Audio] Could not unmute - user interaction required');
        }

        // Hide initializing overlay early since audio is playing
        const initOverlay = document.getElementById('initializingOverlay');
        if (initOverlay && !initOverlay.classList.contains('hidden')) {
          initOverlay.classList.add('fade-out');
          setTimeout(() => initOverlay.classList.add('hidden'), 500);
        }

        // Update play button state
        document.getElementById('playIcon')?.classList.add('hidden');
        document.getElementById('pauseIcon')?.classList.remove('hidden');
        playBtn?.classList.add('playing');

        // Initialize audio analyzer for LED meters
        initGlobalAudioAnalyzer(audio);
        startGlobalMeters();
      } catch (err) {
        console.error('[Audio] Autoplay FAILED:', err.name, err.message);
        // Show play button for user to click
        document.getElementById('playIcon')?.classList.remove('hidden');
        document.getElementById('pauseIcon')?.classList.add('hidden');
        playBtn?.classList.remove('playing');
      }
    };
    attemptAutoplay();
  } else {
    console.log('[Audio] SKIPPING audio setup - audioStreamUrl:', stream.audioStreamUrl, 'audio element:', !!audio);
  }

  if (audio && volumeSlider) {
    audio.volume = volumeSlider.value / 100;
  }

  // Enable the button - unified handler in setupPlaylistPlayButton() handles all modes
  if (playBtn) {
    playBtn.disabled = false;
  }
  
  if (volumeSlider) {
    volumeSlider.oninput = (e) => {
      const volume = e.target.value;
      if (audio) {
        audio.volume = volume / 100;
      }
      // Update playlist volume if active
      if (window.playlistManager) {
        window.playlistManager.setVolume(parseInt(volume));
      }
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
    // Include user info if logged in
    const user = window.liveStreamState?.currentUser;
    const heartbeatData = {
      streamId,
      sessionId: viewerSessionId
    };

    if (user) {
      heartbeatData.userId = user.uid;
      heartbeatData.userName = user.displayName || user.email?.split('@')[0] || 'User';
      heartbeatData.userAvatar = user.photoURL || null;
    }

    const response = await fetch('/api/livestream/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatData)
    });

    const data = await response.json();
    const count = data.count || 0;

    // Update "watching" display only (not viewerCount - that shows totalViews)
    const chatViewers = document.getElementById('chatViewers');
    if (chatViewers) {
      chatViewers.textContent = `${count} watching`;
    }

    // Update online users list from heartbeat response
    if (data.onlineUsers) {
      // Store in cache for getOnlineViewers to use
      if (window.setHeartbeatOnlineUsers) {
        window.setHeartbeatOnlineUsers(data.onlineUsers);
      }
      // Update UI
      if (window.updateOnlineUsers) {
        window.updateOnlineUsers(window.getOnlineViewers());
      }
    }
  } catch (error) {
    console.warn('[Heartbeat] Failed:', error);
  }
}

// ==========================================
// CHAT SYSTEM - Pusher Real-time
// ==========================================
async function setupChat(streamId) {
  // Skip chat setup on fullscreen page - it has its own chat system
  if (window.location.pathname.includes('/live/fullpage')) {
    console.log('[DEBUG] Skipping setupChat on fullscreen page');
    return;
  }
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
  
  // Load initial messages via API (15 messages max)
  try {
    const response = await fetch(`/api/livestream/chat?streamId=${streamId}&limit=15`);
    const result = await response.json();
    if (result.success) {
      chatMessages = result.messages || [];
      // Track active users from initial messages
      chatMessages.forEach(msg => trackActiveUser(msg));
      renderChatMessages(chatMessages, true); // Force scroll to bottom on initial load
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
    console.log('[Reaction] Channel ready to receive reactions');
  });

  chatChannel.bind('pusher:subscription_error', (error) => {
    console.error('[DEBUG] Channel subscription error:', channelName, error);
  });

  // Bind event listeners immediately (Pusher queues them until subscription succeeds)
  chatChannel.bind('new-message', (message) => {
    console.log('[DEBUG] Received new-message event:', message);
    // Add new message to array
    chatMessages.push(message);

    // Track active user
    trackActiveUser(message);

    // Keep only last 15 messages in memory
    if (chatMessages.length > 15) {
      chatMessages = chatMessages.slice(-15);
    }

    // Re-render
    renderChatMessages(chatMessages);

    // Notify mobile tab badge
    if (typeof window.notifyNewChatMessage === 'function') {
      window.notifyNewChatMessage();
    }
  });
  
  // Listen for reactions from other viewers
  // Skip on fullpage - it has its own reaction handler
  if (!window.location.pathname.includes('/live/fullpage')) {
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
  }
  
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
    if (viewerCount && data.totalViews !== undefined || data.currentViewers !== undefined) {
      viewerCount.textContent = data.totalViews || data.currentViewers;
    }
  });

  // Make channel available for shoutout sending
  window.pusherChannel = chatChannel;

  console.log('[Chat] Pusher connected to stream-' + streamId);
  console.log('[Chat] Now calling setup functions for emoji, giphy, and chat input...');

  try {
    setupEmojiPicker();
    console.log('[Chat] setupEmojiPicker completed');
  } catch (e) {
    console.error('[Chat] setupEmojiPicker failed:', e);
  }

  try {
    setupGiphyPicker();
    console.log('[Chat] setupGiphyPicker completed');
  } catch (e) {
    console.error('[Chat] setupGiphyPicker failed:', e);
  }

  try {
    setupChatInput(streamId);
    console.log('[Chat] setupChatInput completed');
  } catch (e) {
    console.error('[Chat] setupChatInput failed:', e);
  }
}

// Track reply state
window.replyingTo = null;

window.replyToMessage = function(msgId, userName, messagePreview) {
  window.replyingTo = { id: msgId, userName, preview: messagePreview };
  const replyIndicator = document.getElementById('replyIndicator');
  if (replyIndicator) {
    replyIndicator.innerHTML = `
      <span style="color: #888;">Replying to </span>
      <span style="color: #dc2626; font-weight: 600;">${escapeHtml(userName)}</span>
      <span style="color: #666; margin-left: 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; display: inline-block; vertical-align: bottom;">${escapeHtml(messagePreview.substring(0, 30))}${messagePreview.length > 30 ? '...' : ''}</span>
      <button onclick="window.cancelReply()" style="margin-left: auto; background: none; border: none; color: #888; cursor: pointer; font-size: 1rem;">×</button>
    `;
    replyIndicator.style.display = 'flex';
  }
  document.getElementById('chatInput')?.focus();
};

window.cancelReply = function() {
  window.replyingTo = null;
  const replyIndicator = document.getElementById('replyIndicator');
  if (replyIndicator) {
    replyIndicator.style.display = 'none';
  }
};

function renderChatMessages(messages, forceScrollToBottom = false) {
  // Skip on fullscreen page - it has its own chat renderer
  if (window.location.pathname.includes('/live/fullpage')) {
    return;
  }

  const container = document.getElementById('chatMessages');
  if (!container) return;

  // Sort messages by createdAt - ascending (oldest first at top, newest last at bottom)
  const sortedMessages = [...messages].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
    const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
    return dateA.getTime() - dateB.getTime();
  });

  const wasAtBottom = forceScrollToBottom || container.scrollTop + container.clientHeight >= container.scrollHeight - 50;

  // Helper to format time
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  container.innerHTML = `
    <div class="chat-welcome" style="text-align: center; padding: 0.75rem; background: #1a1a2e; border-radius: 8px; margin-bottom: 0.5rem;">
      <p style="color: #a5b4fc; margin: 0; font-size: 0.8125rem;">Welcome! Type !help for commands 🎵</p>
    </div>
    ${sortedMessages.map(msg => {
      const time = formatTime(msg.createdAt);
      const isBot = msg.type === 'bot' || msg.userId === 'freshwax-bot';
      const msgPreview = msg.message ? msg.message.substring(0, 50) : '';
      // Use stored reply info directly (works across all screens)
      const replyHtml = msg.replyTo && msg.replyToUserName ? `
        <div style="background: #1a2e1a; border-left: 2px solid #22c55e; padding: 0.25rem 0.5rem; margin-bottom: 0.25rem; border-radius: 4px; font-size: 0.75rem;">
          <span style="color: #22c55e;">↩ </span>
          <span style="color: #22c55e;">${escapeHtml(msg.replyToUserName)}</span>
          <span style="color: #86efac; margin-left: 0.25rem;">${escapeHtml((msg.replyToPreview || 'GIF').substring(0, 40))}${(msg.replyToPreview || '').length > 40 ? '...' : ''}</span>
        </div>
      ` : '';

      // System messages (e.g., skip notifications) - simple centered styling
      if (msg.type === 'system' || msg.userId === 'system') {
        return `
          <div class="chat-message chat-system-message" style="padding: 0.5rem; margin: 0.5rem 0; animation: slideIn 0.2s ease-out; background: rgba(34, 197, 94, 0.1); border-radius: 8px; text-align: center; border: 1px solid rgba(34, 197, 94, 0.3);">
            <div style="color: #22c55e; font-size: 0.875rem; font-weight: 500;">${escapeHtml(msg.message)}</div>
          </div>
        `;
      }

      // Bot messages have special styling (no reply button) - Blue theme
      if (isBot) {
        return `
          <div class="chat-message chat-bot-message" style="padding: 0.5rem; margin: 0.25rem 0; animation: slideIn 0.2s ease-out; background: linear-gradient(135deg, #1a1a2e 0%, #1e293b 100%); border-radius: 8px; border-left: 3px solid #3b82f6;">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
              <img src="/logo.webp" alt="Bot" style="width: 20px; height: 20px; border-radius: 50%; background: #fff; padding: 2px;" />
              <span style="font-weight: 600; color: #3b82f6; font-size: 0.8125rem;">FreshWax</span>
              <span style="background: #3b82f6; color: #fff; font-size: 0.625rem; padding: 0.125rem 0.375rem; border-radius: 4px; font-weight: 600;">BOT</span>
              <span style="font-size: 0.6875rem; color: #666; margin-left: auto;">${time}</span>
            </div>
            <div style="color: #bfdbfe; font-size: 0.875rem; word-break: break-word; line-height: 1.5; white-space: pre-line;">${escapeHtml(msg.message)}</div>
          </div>
        `;
      }

      // Plus member crown badge
      const crownBadge = msg.isPro ? '<svg viewBox="0 0 24 24" fill="#f59e0b" width="14" height="14" style="margin-left: 4px; vertical-align: middle;"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>' : '';

      if (msg.type === 'giphy' && msg.giphyUrl) {
        return `
          <div class="chat-message" style="padding: 0.5rem 0; animation: slideIn 0.2s ease-out; position: relative;" onmouseenter="this.querySelector('.reply-btn').style.opacity='1'" onmouseleave="this.querySelector('.reply-btn').style.opacity='0'">
            ${replyHtml}
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">
              <span style="font-weight: 600; color: #dc2626; font-size: 0.8125rem; display: inline-flex; align-items: center;">${escapeHtml(msg.userName)}${crownBadge}</span>
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <button class="reply-btn" onclick="window.replyToMessage('${msg.id}', '${escapeHtml(msg.userName)}', 'GIF')" style="opacity: 0; background: none; border: none; color: #22c55e; cursor: pointer; font-size: 0.75rem; transition: opacity 0.2s;">↩ Reply</button>
                <span style="font-size: 0.6875rem; color: #666;">${time}</span>
              </div>
            </div>
            <img src="${msg.giphyUrl}" alt="GIF" style="max-width: 300px; border-radius: 8px;" onload="setTimeout(() => this.scrollIntoView({ behavior: 'instant', block: 'end' }), 50);" />
          </div>
        `;
      }

      return `
        <div class="chat-message" style="padding: 0.5rem 0; animation: slideIn 0.2s ease-out; position: relative;" onmouseenter="this.querySelector('.reply-btn').style.opacity='1'" onmouseleave="this.querySelector('.reply-btn').style.opacity='0'">
          ${replyHtml}
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.125rem;">
            <span style="font-weight: 600; color: #dc2626; font-size: 0.8125rem; display: inline-flex; align-items: center;">${escapeHtml(msg.userName)}${crownBadge}</span>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <button class="reply-btn" onclick="window.replyToMessage('${msg.id}', '${escapeHtml(msg.userName)}', '${escapeHtml(msgPreview).replace(/'/g, "\\'")}')" style="opacity: 0; background: none; border: none; color: #22c55e; cursor: pointer; font-size: 0.75rem; transition: opacity 0.2s;">↩ Reply</button>
              <span style="font-size: 0.6875rem; color: #666;">${time}</span>
            </div>
          </div>
          <div style="color: #fff; font-size: 1rem; word-break: break-word; line-height: 1.5;">${escapeHtml(msg.message)}</div>
        </div>
      `;
    }).join('')}
  `;

  if (wasAtBottom || forceScrollToBottom) {
    const scrollToBottom = () => {
      // Try scrollIntoView on last message
      const lastMessage = container.querySelector('.chat-message:last-of-type');
      if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'instant', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    };

    // Scroll immediately
    scrollToBottom();

    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(scrollToBottom);

    // Multiple attempts for images/GIFs that load async
    if (forceScrollToBottom) {
      setTimeout(scrollToBottom, 50);
      setTimeout(scrollToBottom, 200);
      setTimeout(scrollToBottom, 500);
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setupEmojiPicker() {
  // Skip on fullscreen page - it has its own emoji picker
  if (window.location.pathname.includes('/live/fullpage')) {
    console.log('[EmojiPicker] Skipping on fullscreen page');
    return;
  }
  console.log('[EmojiPicker] Setting up emoji picker...');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPicker = document.getElementById('emojiPicker');
  const emojiGrid = document.getElementById('emojiGrid');
  const giphyModal = document.getElementById('giphyModal');

  console.log('[EmojiPicker] Elements found:', {
    emojiBtn: !!emojiBtn,
    emojiPicker: !!emojiPicker,
    emojiGrid: !!emojiGrid,
    giphyModal: !!giphyModal
  });

  let currentCategory = 'music';
  
  function renderEmojis(category) {
    const emojis = EMOJI_CATEGORIES[category] || [];
    // Get fresh reference to handle View Transitions
    const grid = document.getElementById('emojiGrid');
    if (grid) {
      grid.innerHTML = emojis.map(emoji =>
        `<button style="padding: 0.5rem; background: none; border: none; font-size: 1.25rem; cursor: pointer; border-radius: 6px; -webkit-tap-highlight-color: transparent;" data-emoji="${emoji}">${emoji}</button>`
      ).join('');

      grid.querySelectorAll('button').forEach(btn => {
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
  
  // Define the toggle function that will be used by both onclick attribute and programmatic handlers
  // Always get fresh DOM references to handle View Transitions
  window.toggleEmojiPicker = function() {
    console.log('[EmojiPicker] Toggle called');
    const picker = document.getElementById('emojiPicker');
    const gifModal = document.getElementById('giphyModal');
    const btn = document.getElementById('emojiBtn');

    picker?.classList.toggle('hidden');
    gifModal?.classList.add('hidden');
    document.body.style.overflow = ''; // Re-enable scroll if GIF modal was open
    btn?.classList.toggle('active');
    document.getElementById('giphyBtn')?.classList.remove('active');

    if (!picker?.classList.contains('hidden')) {
      renderEmojis(currentCategory);
    }
  };

  // Also attach emoji category switch to window
  window.switchEmojiCategory = function(category) {
    document.querySelectorAll('.emoji-cat').forEach(b => b.classList.remove('active'));
    document.querySelector(`.emoji-cat[data-cat="${category}"]`)?.classList.add('active');
    currentCategory = category;
    renderEmojis(currentCategory);
  };

  if (emojiBtn) {
    console.log('[EmojiPicker] Attaching click handler to emoji button');
    emojiBtn.onclick = window.toggleEmojiPicker;
  } else {
    console.warn('[EmojiPicker] Emoji button NOT found!');
  }

  // Initialize with default category
  renderEmojis(currentCategory);
}

function setupGiphyPicker() {
  // Skip on fullscreen page - it has its own giphy picker
  if (window.location.pathname.includes('/live/fullpage')) {
    console.log('[GiphyPicker] Skipping on fullscreen page');
    return;
  }
  console.log('[GiphyPicker] Setting up giphy picker...');
  console.log('[GiphyPicker] GIPHY_API_KEY set:', !!GIPHY_API_KEY, GIPHY_API_KEY ? `(${GIPHY_API_KEY.length} chars)` : '');
  const giphyBtn = document.getElementById('giphyBtn');
  const giphyModal = document.getElementById('giphyModal');
  const giphySearch = document.getElementById('giphySearch');
  const giphyGrid = document.getElementById('giphyGrid');
  const emojiPicker = document.getElementById('emojiPicker');

  console.log('[GiphyPicker] Elements found:', {
    giphyBtn: !!giphyBtn,
    giphyModal: !!giphyModal,
    giphySearch: !!giphySearch,
    giphyGrid: !!giphyGrid
  });

  let searchTimeout;
  let currentCategory = 'trending';

  async function searchGiphy(query, category = null) {
    if (!GIPHY_API_KEY) {
      if (giphyGrid) giphyGrid.innerHTML = '<p class="gif-loading">Giphy not configured</p>';
      return;
    }

    // Show loading state
    if (giphyGrid) giphyGrid.innerHTML = '<p class="gif-loading">Loading GIFs...</p>';

    try {
      let endpoint;
      if (query) {
        // Search query takes priority
        endpoint = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=32&rating=pg-13`;
      } else if (category && category !== 'trending') {
        // Category search
        endpoint = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(category)}&limit=32&rating=pg-13`;
      } else {
        // Default to trending
        endpoint = `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=32&rating=pg-13`;
      }

      const response = await fetch(endpoint);
      const data = await response.json();

      if (data.data?.length > 0 && giphyGrid) {
        giphyGrid.innerHTML = data.data.map(gif => `
          <div class="giphy-item" data-url="${gif.images.fixed_height.url}" data-id="${gif.id}">
            <img src="${gif.images.fixed_height_small.url}" alt="${gif.title}" loading="lazy" />
          </div>
        `).join('');

        giphyGrid.querySelectorAll('.giphy-item').forEach(item => {
          item.onclick = () => {
            sendGiphyMessage(item.dataset.url, item.dataset.id);
            giphyModal?.classList.add('hidden');
            giphyBtn?.classList.remove('active');
            document.body.style.overflow = '';
          };
        });
      } else if (giphyGrid) {
        giphyGrid.innerHTML = '<p class="gif-loading">No GIFs found</p>';
      }
    } catch (error) {
      console.error('[Giphy] Error:', error);
      if (giphyGrid) giphyGrid.innerHTML = '<p class="gif-loading">Error loading GIFs</p>';
    }
  }

  // Category switching
  window.switchGifCategory = function(category) {
    currentCategory = category;
    // Update active button
    document.querySelectorAll('.gif-cat').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === category);
    });
    // Clear search and load category
    if (giphySearch) giphySearch.value = '';
    searchGiphy('', category);
  };

  // Debounced search
  window.searchGiphyDebounced = function(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      if (query) {
        // Clear category selection when searching
        document.querySelectorAll('.gif-cat').forEach(btn => btn.classList.remove('active'));
      }
      searchGiphy(query);
    }, 400);
  };

  // Toggle modal
  window.toggleGiphyPicker = function() {
    console.log('[GiphyPicker] Toggle called');
    emojiPicker?.classList.add('hidden');
    document.getElementById('emojiBtn')?.classList.remove('active');

    if (giphyModal?.classList.contains('hidden')) {
      giphyModal.classList.remove('hidden');
      giphyBtn?.classList.add('active');
      document.body.style.overflow = 'hidden'; // Prevent background scroll
      // Reset to trending
      currentCategory = 'trending';
      document.querySelectorAll('.gif-cat').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.cat === 'trending');
      });
      if (giphySearch) giphySearch.value = '';
      searchGiphy('', 'trending');
    } else {
      giphyModal?.classList.add('hidden');
      giphyBtn?.classList.remove('active');
      document.body.style.overflow = '';
    }
  };

  if (giphyBtn) {
    console.log('[GiphyPicker] Attaching click handler to giphy button');
    giphyBtn.onclick = () => {
      console.log('[GiphyPicker] Giphy button clicked!');
      window.toggleGiphyPicker();
    };
  } else {
    console.warn('[GiphyPicker] Giphy button NOT found!');
  }

  // ESC key to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !giphyModal?.classList.contains('hidden')) {
      window.toggleGiphyPicker();
    }
  });
}

async function sendGiphyMessage(giphyUrl, giphyId) {
  console.log('[GIF] sendGiphyMessage called with:', { giphyUrl, giphyId });
  console.log('[GIF] currentUser:', !!currentUser, 'currentStream:', !!currentStream);

  if (!currentUser) {
    console.error('[GIF] No current user - not logged in');
    return;
  }
  if (!currentStream) {
    console.error('[GIF] No current stream');
    return;
  }

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

// Expose for LiveChat component
window.sendGifMessage = sendGiphyMessage;

function setupChatInput(streamId) {
  // Skip on fullscreen page - it has its own chat input handlers
  if (window.location.pathname.includes('/live/fullpage')) {
    console.log('[ChatInput] Skipping on fullscreen page');
    return;
  }
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');

  // Admin UIDs for chat commands
  const ADMIN_UIDS = [
    'Y3TGc171cHSWTqZDRSniyu7Jxc33',  // freshwaxonline@gmail.com
    '8WmxYeCp4PSym5iWHahgizokn5F2'   // davidhagon@gmail.com
  ];

  async function sendMessage() {
    if (!currentUser || !input?.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    // Check for !skip command (Plus members get 3/day, admins unlimited)
    if (message.toLowerCase() === '!skip') {
      if (!window.playlistManager || !window.isPlaylistActive) {
        console.log('[Chat] !skip: No playlist active');
        return;
      }

      try {
        // Call skip API to check permission and track usage
        const skipResponse = await fetch('/api/playlist/skip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUser.uid })
        });
        const skipResult = await skipResponse.json();

        if (!skipResult.allowed) {
          // Show error message to user
          const chatMessages = document.getElementById('chatMessages');
          if (chatMessages) {
            const errorNotice = document.createElement('div');
            errorNotice.className = 'chat-system-message chat-error';
            errorNotice.textContent = skipResult.reason || 'Cannot skip right now';
            chatMessages.appendChild(errorNotice);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            // Auto-remove after 5 seconds
            setTimeout(() => errorNotice.remove(), 5000);
          }
          console.log('[Chat] !skip denied:', skipResult.reason);
          return;
        }

        // Skip allowed - execute it
        window.playlistManager.skipTrack();
        console.log('[Chat] !skip executed:', skipResult.isAdmin ? 'admin' : `Plus user (${skipResult.remaining} remaining)`);

        // Determine skip message based on who skipped
        const skipMessage = skipResult.isAdmin
          ? '⏭️ Track skipped by admin'
          : `⏭️ Track skipped by Plus member (${skipResult.remaining} skips remaining today)`;

        // Broadcast skip notification to all users
        const streamId = window.currentStreamId || 'playlist-global';
        await fetch('/api/livestream/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            streamId: streamId,
            userId: 'system',
            userName: 'System',
            message: skipMessage,
            type: 'system'
          })
        });
        console.log('[Chat] Skip notification broadcast to all users');
      } catch (err) {
        console.error('[Chat] !skip error:', err);
        // Show error to user
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
          const errorNotice = document.createElement('div');
          errorNotice.className = 'chat-system-message chat-error';
          errorNotice.textContent = 'Failed to skip track. Please try again.';
          chatMessages.appendChild(errorNotice);
          chatMessages.scrollTop = chatMessages.scrollHeight;
          setTimeout(() => errorNotice.remove(), 5000);
        }
      }
      return; // Don't send !skip to chat
    }

    // Check for Plus-only chat commands: !ping, !vibe, !quote, !hype, !shoutout, !np, !uptime
    const plusCommands = ['!ping', '!vibe', '!quote', '!hype', '!shoutout', '!np', '!uptime'];
    const lowerMessage = message.toLowerCase();
    const matchedCommand = plusCommands.find(cmd => lowerMessage.startsWith(cmd));

    if (matchedCommand) {
      const command = matchedCommand.slice(1); // Remove the !
      const args = message.slice(matchedCommand.length).trim();

      try {
        // Get current track info if available
        let currentTrack = null;
        if (window.playlistManager && window.playlistManager.playlist) {
          const queue = window.playlistManager.playlist.queue;
          if (queue && queue.length > 0) {
            currentTrack = {
              title: queue[0].title,
              artist: queue[0].artist
            };
          }
        }

        // Get stream start time if available
        const streamStartTime = window.streamStartTime || null;

        const response = await fetch('/api/chat/plus-command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: currentUser.uid,
            userName: currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
            command,
            args,
            streamId: window.currentStreamId || 'playlist-global',
            streamStartTime,
            currentTrack
          })
        });

        const result = await response.json();

        if (!result.allowed) {
          // Show error message for non-Plus users
          const chatMessages = document.getElementById('chatMessages');
          if (chatMessages) {
            const errorNotice = document.createElement('div');
            errorNotice.className = 'chat-system-message chat-error';
            errorNotice.textContent = result.error || 'This command requires Plus membership';
            chatMessages.appendChild(errorNotice);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            setTimeout(() => errorNotice.remove(), 5000);
          }
          return;
        }

        // Broadcast the bot response to chat
        const streamId = window.currentStreamId || 'playlist-global';
        await fetch('/api/livestream/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            streamId: streamId,
            userId: result.type === 'system' ? 'system' : 'bot',
            userName: result.type === 'system' ? 'System' : 'FreshWax Bot',
            message: result.response,
            type: result.type || 'bot',
            isBot: true
          })
        });

        console.log('[Chat] Plus command executed:', command);
      } catch (err) {
        console.error('[Chat] Plus command error:', err);
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
          const errorNotice = document.createElement('div');
          errorNotice.className = 'chat-system-message chat-error';
          errorNotice.textContent = 'Command failed. Please try again.';
          chatMessages.appendChild(errorNotice);
          chatMessages.scrollTop = chatMessages.scrollHeight;
          setTimeout(() => errorNotice.remove(), 5000);
        }
      }
      return; // Don't send command to regular chat
    }

    // Get reply data and clear it
    const replyData = window.replyingTo ? {
      replyTo: window.replyingTo.id,
      replyToUserName: window.replyingTo.userName,
      replyToPreview: window.replyingTo.preview
    } : {};
    if (window.replyingTo) {
      window.cancelReply();
    }

    try {
      const response = await fetch('/api/livestream/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId,
          userId: currentUser.uid,
          userName: currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
          userAvatar: currentUser.photoURL || null,
          isPro: window.userIsPro === true,
          message,
          type: 'text',
          ...replyData
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
  // Skip if emoji animations are disabled (no active livestream)
  if (!window.emojiAnimationsEnabled) {
    console.log('[Reaction] Emoji animations disabled, skipping');
    return;
  }

  // Only show emojis on live stream pages (ViewTransitions keeps Pusher alive across pages)
  const path = window.location.pathname;
  if (!path.startsWith('/live') && !path.includes('/account/dj-lobby')) {
    return;
  }

  console.log('[Reaction] createFloatingEmojiFromBroadcast called with:', emojiList);
  const playerArea = document.querySelector('.video-player') || document.querySelector('.player-wrapper') || document.querySelector('.player-column');
  let x, y;

  if (playerArea) {
    const rect = playerArea.getBoundingClientRect();
    x = rect.left + Math.random() * rect.width;
    y = rect.top + rect.height * 0.5 + Math.random() * rect.height * 0.3;
    console.log('[Reaction] Player area found, position:', { x, y, rect });
  } else {
    // Center of screen fallback
    x = window.innerWidth * 0.25 + Math.random() * window.innerWidth * 0.5;
    y = window.innerHeight * 0.3 + Math.random() * window.innerHeight * 0.4;
    console.log('[Reaction] No player area, using centered window position:', { x, y });
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
    window.liveStreamState.currentUser = user; // Expose for LiveChat

    const loginPrompt = document.getElementById('loginPrompt');
    const chatForm = document.getElementById('chatForm');
    
    if (user) {
      loginPrompt?.classList.add('hidden');
      chatForm?.classList.remove('hidden');

      // Add current user to online users list immediately
      activeUsers.set(user.uid, {
        id: user.uid,
        name: user.displayName || user.email?.split('@')[0] || 'User',
        avatar: user.photoURL || null,
        lastSeen: Date.now()
      });
      if (window.updateOnlineUsers) {
        window.updateOnlineUsers(window.getOnlineViewers());
      }

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

// Close emoji picker on outside click (GIF modal handles its own close via overlay onclick)
document.addEventListener('click', (e) => {
  const emojiPicker = document.getElementById('emojiPicker');
  const emojiBtn = document.getElementById('emojiBtn');

  if (!emojiPicker?.contains(e.target) && !emojiBtn?.contains(e.target)) {
    emojiPicker?.classList.add('hidden');
    emojiBtn?.classList.remove('active');
  }
});

// ==========================================
// INITIALIZE
// ==========================================

// Track if we've already initialized to prevent double-init
let isInitialized = false;

async function safeInit() {
  // Skip entirely on fullscreen page - it has its own implementation
  if (window.location.pathname.includes('/live/fullpage')) {
    console.log('[LiveStream] On fullscreen page, skipping init');
    return;
  }

  // Check if we're on the live page
  if (!window.location.pathname.startsWith('/live')) {
    console.log('[LiveStream] Not on live page, skipping init');
    return;
  }

  // Allow re-initialization (for View Transitions navigation)
  console.log('[LiveStream] Initializing...');
  isInitialized = true;
  await init();
}

// Initial load
safeInit();

// Cleanup before navigating away (Astro View Transitions)
document.addEventListener('astro:before-swap', () => {
  console.log('[LiveStream] Cleaning up before navigation...');
  // Destroy HLS player to prevent memory leaks and conflicts
  if (hlsPlayer) {
    try {
      hlsPlayer.destroy();
      hlsPlayer = null;
    } catch (e) {
      console.error('[LiveStream] Error destroying HLS player:', e);
    }
  }
  // Reset initialization flag
  isInitialized = false;
});

// Re-initialize on Astro View Transitions navigation
document.addEventListener('astro:page-load', () => {
  console.log('[LiveStream] astro:page-load event fired');
  isInitialized = false; // Reset flag to allow re-init
  chatMessages = []; // Clear old messages
  safeInit();
});
