// public/live-stream.js
// Live stream page functionality

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore, collection, query, where, orderBy, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

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

// State
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

// GIPHY API Key from page
const GIPHY_API_KEY = window.GIPHY_API_KEY || '';

// Emoji categories
const EMOJI_CATEGORIES = {
  music: ['🎵', '🎶', '🎧', '🎤', '🎹', '🥁', '🎸', '🎺', '🎷', '🔊', '📻', '💿'],
  reactions: ['🔥', '❤️', '💯', '🙌', '👏', '🤘', '✨', '💥', '⚡', '🌟', '💪', '👊'],
  faces: ['😍', '🥰', '😎', '🤩', '🥳', '😈', '👀', '🤯', '😱', '🫠', '💀', '😂'],
  vibes: ['🌴', '🌙', '🌊', '🍾', '🥂', '💨', '🌈', '☀️', '🌺', '🦋', '🐍', '🦁']
};

// Initialize
async function init() {
  await checkLiveStatus();
  setupAuthListener();
}

// Check if any stream is live
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
          <div class="scheduled-item" style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: #1a1a1a; border-radius: 8px;">
            <span style="color: #dc2626; font-weight: 600; min-width: 80px;">${timeStr}</span>
            <div>
              <div style="color: #fff; font-weight: 500;">${s.title}</div>
              <div style="color: #888; font-size: 0.875rem;">${s.djName}</div>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

// Show live stream
function showLiveStream(stream) {
  currentStream = stream;
  
  // Expose stream ID globally for reaction buttons
  window.currentStreamId = stream.id;
  window.firebaseAuth = auth;
  
  document.getElementById('offlineState')?.classList.add('hidden');
  document.getElementById('liveState')?.classList.remove('hidden');
  
  // Update stream info
  const streamTitle = document.getElementById('streamTitle');
  const djName = document.getElementById('djName');
  const streamGenre = document.getElementById('streamGenre');
  const viewerCount = document.getElementById('viewerCount');
  const likeCount = document.getElementById('likeCount');
  const avgRating = document.getElementById('avgRating');
  const streamDescription = document.getElementById('streamDescription');
  const djAvatar = document.getElementById('djAvatar');
  const streamCover = document.getElementById('streamCover');
  
  // Audio-only placeholder elements
  const audioDjName = document.getElementById('audioDjName');
  const audioShowTitle = document.getElementById('audioShowTitle');
  const vinylDjAvatar = document.getElementById('vinylDjAvatar');
  
  if (streamTitle) streamTitle.textContent = stream.title;
  if (djName) djName.textContent = stream.djName;
  if (streamGenre) streamGenre.textContent = stream.genre || 'Jungle / D&B';
  if (viewerCount) viewerCount.textContent = stream.currentViewers || 0;
  if (likeCount) likeCount.textContent = stream.totalLikes || 0;
  if (avgRating) avgRating.textContent = (stream.averageRating || 0).toFixed(1);
  if (streamDescription) streamDescription.textContent = stream.description || 'No description';
  if (stream.djAvatar && djAvatar) djAvatar.src = stream.djAvatar;
  if (stream.coverImage && streamCover) streamCover.src = stream.coverImage;
  
  // Update audio-only placeholder
  if (audioDjName) audioDjName.textContent = stream.djName || 'DJ';
  if (audioShowTitle) audioShowTitle.textContent = stream.title || 'Live on Fresh Wax';
  if (vinylDjAvatar && stream.djAvatar) vinylDjAvatar.src = stream.djAvatar;
  
  // Setup player based on stream type/source
  if (stream.streamSource === 'twitch' && stream.twitchChannel) {
    setupTwitchPlayer(stream);
  } else if (stream.streamSource === 'red5' || stream.hlsUrl) {
    setupHlsPlayer(stream);
  } else if (stream.streamSource === 'icecast' || stream.audioStreamUrl) {
    setupAudioPlayer(stream);
  } else {
    // Fallback to audio player
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

// HLS.js instance
let hlsPlayer = null;

// Setup HLS player for Red5 streams
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
    // Fallback to audio if no HLS URL
    setupAudioPlayer(stream);
    return;
  }
  
  console.log('Setting up HLS player with URL:', hlsUrl);
  
  // Initialize audio analyzer for LED meters when video plays
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
  
  if (videoElement) {
    videoElement.addEventListener('play', onVideoPlay);
    videoElement.addEventListener('pause', onVideoPause);
    videoElement.addEventListener('ended', onVideoPause);
    
    // Check if HLS is supported natively (Safari)
    if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = hlsUrl;
      videoElement.addEventListener('loadedmetadata', () => {
        videoElement.play().catch(console.error);
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
        backBufferLength: 90
      });
      
      hlsPlayer.loadSource(hlsUrl);
      hlsPlayer.attachMedia(videoElement);
      
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS manifest parsed, starting playback');
        videoElement.play().catch(console.error);
      });
      
      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('Network error, attempting to recover...');
              hlsPlayer.startLoad();
              // Auto-reconnect after 3 seconds if still failing
              setTimeout(() => {
                if (!isPlaying) {
                  console.log('Auto-reconnecting...');
                  showReconnecting();
                  hlsPlayer.loadSource(hlsUrl);
                }
              }, 3000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('Media error, attempting to recover...');
              hlsPlayer.recoverMediaError();
              break;
            default:
              console.error('Fatal HLS error, cannot recover');
              hlsPlayer.destroy();
              // Show error message to user
              showStreamError('Stream unavailable. The DJ may still be connecting.');
              // Auto-retry after 5 seconds
              setTimeout(() => {
                console.log('Auto-retrying connection...');
                showReconnecting();
                setupHlsPlayer(currentStream);
              }, 5000);
              break;
          }
        }
      });
    } else {
      console.error('HLS not supported in this browser');
      showStreamError('Your browser does not support HLS playback. Please use Chrome, Firefox, or Safari.');
    }
    
    // Setup Media Session for lock screen controls
    setupMediaSession(stream);
    
    // Setup recording capability
    setupRecording(videoElement);
  }
}

// Show reconnecting message
function showReconnecting() {
  const videoPlayer = document.getElementById('videoPlayer');
  if (videoPlayer) {
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
    
    // Remove after 5 seconds
    setTimeout(() => overlay.remove(), 5000);
  }
}

// Show stream error message
function showStreamError(message) {
  const videoPlayer = document.getElementById('videoPlayer');
  if (videoPlayer) {
    videoPlayer.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #1a1a1a; color: #fff; padding: 2rem; text-align: center;">
        <div style="font-size: 3rem; margin-bottom: 1rem;">📡</div>
        <h3 style="margin: 0 0 0.5rem 0;">Connecting to Stream...</h3>
        <p style="color: #888; margin: 0;">${message}</p>
        <button onclick="location.reload()" style="margin-top: 1rem; padding: 0.75rem 1.5rem; background: #dc2626; border: none; border-radius: 8px; color: #fff; cursor: pointer;">
          Retry
        </button>
      </div>
    `;
  }
}

// Global stereo audio analyzer for LED meters
let globalAudioContext = null;
let globalAnalyserLeft = null;
let globalAnalyserRight = null;
let globalAnimationId = null;
let globalMediaSource = null;

function initGlobalAudioAnalyzer(mediaElement) {
  if (globalAudioContext && globalMediaSource) {
    // Already initialized for this element
    return;
  }
  
  try {
    globalAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    globalMediaSource = globalAudioContext.createMediaElementSource(mediaElement);
    
    // Create stereo splitter
    const splitter = globalAudioContext.createChannelSplitter(2);
    
    // Create analyzers for each channel
    globalAnalyserLeft = globalAudioContext.createAnalyser();
    globalAnalyserRight = globalAudioContext.createAnalyser();
    globalAnalyserLeft.fftSize = 256;
    globalAnalyserRight.fftSize = 256;
    globalAnalyserLeft.smoothingTimeConstant = 0.5;
    globalAnalyserRight.smoothingTimeConstant = 0.5;
    
    // Connect source -> splitter -> analyzers
    globalMediaSource.connect(splitter);
    splitter.connect(globalAnalyserLeft, 0);
    splitter.connect(globalAnalyserRight, 1);
    
    // Also connect to destination for playback
    globalMediaSource.connect(globalAudioContext.destination);
    
    console.log('[Live] Global audio analyzer initialized');
  } catch (err) {
    console.error('[Live] Global audio analyzer error:', err);
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
  
  // Get frequency data
  const leftData = new Uint8Array(globalAnalyserLeft.frequencyBinCount);
  const rightData = new Uint8Array(globalAnalyserRight.frequencyBinCount);
  globalAnalyserLeft.getByteFrequencyData(leftData);
  globalAnalyserRight.getByteFrequencyData(rightData);
  
  // Calculate RMS levels (more accurate than just averaging)
  let leftSum = 0, rightSum = 0;
  for (let i = 0; i < leftData.length; i++) {
    leftSum += leftData[i] * leftData[i];
    rightSum += rightData[i] * rightData[i];
  }
  const leftRms = Math.sqrt(leftSum / leftData.length);
  const rightRms = Math.sqrt(rightSum / rightData.length);
  
  // Normalize to 0-14 range (14 LEDs)
  const leftLevel = Math.min(14, Math.floor((leftRms / 255) * 18));
  const rightLevel = Math.min(14, Math.floor((rightRms / 255) * 18));
  
  // Update LEDs
  leftLeds.forEach((led, i) => {
    led.classList.toggle('active', i < leftLevel);
  });
  rightLeds.forEach((led, i) => {
    led.classList.toggle('active', i < rightLevel);
  });
  
  globalAnimationId = requestAnimationFrame(updateGlobalMeters);
}

function stopGlobalMeters() {
  if (globalAnimationId) {
    cancelAnimationFrame(globalAnimationId);
    globalAnimationId = null;
  }
  // Turn off all LEDs
  document.querySelectorAll('.led-strip .led').forEach(led => {
    led.classList.remove('active');
  });
}

function startGlobalMeters() {
  if (!globalAnimationId) {
    updateGlobalMeters();
  }
}

// ==========================================
// STREAM RECORDING FUNCTIONALITY
// ==========================================

function setupRecording(mediaElement) {
  const recordBtn = document.getElementById('recordBtn');
  const recordDuration = document.getElementById('recordDuration');
  
  if (!recordBtn) return;
  
  // Enable record button when stream is playing
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
    console.error('[Recording] No media element available');
    return;
  }
  
  try {
    // Get the media stream from the element
    let stream;
    if (mediaElement.captureStream) {
      stream = mediaElement.captureStream();
    } else if (mediaElement.mozCaptureStream) {
      stream = mediaElement.mozCaptureStream();
    } else {
      alert('Recording is not supported in your browser. Please use Chrome, Firefox, or Edge.');
      return;
    }
    
    // Check for audio tracks
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      alert('No audio track available to record.');
      return;
    }
    
    // Create audio-only stream for smaller file size
    const audioStream = new MediaStream(audioTracks);
    
    // Determine best audio format
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/ogg;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = '';  // Let browser choose
        }
      }
    }
    
    const options = mimeType ? { mimeType, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 };
    
    mediaRecorder = new MediaRecorder(audioStream, options);
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = () => {
      downloadRecording();
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('[Recording] Error:', event.error);
      stopRecording();
      alert('Recording error occurred. Please try again.');
    };
    
    // Start recording
    mediaRecorder.start(1000); // Collect data every second
    isRecording = true;
    recordingStartTime = Date.now();
    
    // Update UI
    recordBtn?.classList.add('recording');
    recordBtn.querySelector('.record-text').textContent = 'STOP';
    recordDuration?.classList.remove('hidden');
    
    // Update duration display
    recordingInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      if (recordDuration) recordDuration.textContent = `${mins}:${secs}`;
    }, 1000);
    
    console.log('[Recording] Started');
    
  } catch (err) {
    console.error('[Recording] Failed to start:', err);
    alert('Failed to start recording. Please ensure the stream is playing.');
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
  
  // Update UI
  recordBtn?.classList.remove('recording');
  if (recordBtn) recordBtn.querySelector('.record-text').textContent = 'REC';
  recordDuration?.classList.add('hidden');
  if (recordDuration) recordDuration.textContent = '00:00';
  
  console.log('[Recording] Stopped');
}

function downloadRecording() {
  if (recordedChunks.length === 0) {
    console.log('[Recording] No data to download');
    return;
  }
  
  // Create blob from recorded chunks
  const blob = new Blob(recordedChunks, { type: recordedChunks[0].type || 'audio/webm' });
  
  // Generate filename with DJ name and title
  const djName = document.getElementById('djName')?.textContent || 'Unknown DJ';
  const streamTitle = document.getElementById('streamTitle')?.textContent || 'Live Stream';
  const date = new Date().toISOString().split('T')[0];
  const duration = recordDuration?.textContent || '';
  
  // Sanitize filename
  const sanitize = (str) => str.replace(/[^a-zA-Z0-9\s\-\_]/g, '').trim().replace(/\s+/g, '_');
  const filename = `FreshWax_${sanitize(djName)}_${sanitize(streamTitle)}_${date}.webm`;
  
  // Create download link
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  
  // Cleanup
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  
  recordedChunks = [];
  
  console.log(`[Recording] Downloaded: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
}

// Cleanup recording on page unload
window.addEventListener('beforeunload', () => {
  if (isRecording) {
    stopRecording();
  }
});

// Setup Twitch player
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

// Setup audio player
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
    playBtn.onclick = () => {
      if (isPlaying) {
        audio?.pause();
        document.getElementById('playIcon')?.classList.remove('hidden');
        document.getElementById('pauseIcon')?.classList.add('hidden');
        stopGlobalMeters();
      } else {
        // Initialize analyzer on first play (must be after user interaction)
        initGlobalAudioAnalyzer(audio);
        if (globalAudioContext?.state === 'suspended') {
          globalAudioContext.resume();
        }
        audio?.play().catch(console.error);
        document.getElementById('playIcon')?.classList.add('hidden');
        document.getElementById('pauseIcon')?.classList.remove('hidden');
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
  
  // Setup recording capability
  setupRecording(audio);
}

// Join stream as viewer
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
    
    // Start heartbeat
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
    console.error('Error joining stream:', error);
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

// Setup chat
function setupChat(streamId) {
  // Real-time chat listener
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
      if (change.type === 'added') {
        hasNewMessage = true;
      }
    });
    
    snapshot.forEach(doc => {
      messages.push({ id: doc.id, ...doc.data() });
    });
    
    messages.reverse();
    renderChatMessages(messages);
    
    // Notify mobile tabs of new message
    if (hasNewMessage && typeof window.notifyNewChatMessage === 'function') {
      window.notifyNewChatMessage();
    }
  }, (error) => {
    // Handle permission errors gracefully
    console.warn('[Chat] Firestore listener error:', error.code);
    if (error.code === 'permission-denied') {
      console.info('[Chat] Update Firestore rules to allow reading livestream-chat collection');
    }
  });
  
  // Setup emoji picker
  setupEmojiPicker();
  
  // Setup Giphy picker
  setupGiphyPicker();
  
  // Setup send message
  setupChatInput(streamId);
}

// Render chat messages
function renderChatMessages(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  
  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
  
  container.innerHTML = `
    <div class="chat-welcome" style="text-align: center; padding: 1rem; background: #1a1a2e; border-radius: 8px;">
      <p style="color: #a5b4fc; margin: 0; font-size: 0.875rem;">Welcome to the chat! Be respectful and enjoy the music 🎵</p>
    </div>
    ${messages.map(msg => {
      const initial = (msg.userName || 'A')[0].toUpperCase();
      
      if (msg.type === 'giphy' && msg.giphyUrl) {
        return `
          <div style="display: flex; gap: 0.75rem; animation: slideIn 0.2s ease-out;">
            <div style="width: 32px; height: 32px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; color: #fff; flex-shrink: 0;">${initial}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 600; color: #6366f1; font-size: 0.8125rem; margin-bottom: 0.25rem;">${msg.userName}</div>
              <img src="${msg.giphyUrl}" alt="GIF" style="max-width: 200px; border-radius: 8px; margin-top: 0.5rem;" />
            </div>
          </div>
        `;
      }
      
      return `
        <div style="display: flex; gap: 0.75rem; animation: slideIn 0.2s ease-out;">
          <div style="width: 32px; height: 32px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; color: #fff; flex-shrink: 0;">${initial}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; color: #6366f1; font-size: 0.8125rem; margin-bottom: 0.25rem;">${msg.userName}</div>
            <div style="color: #fff; font-size: 0.9375rem; word-break: break-word;">${escapeHtml(msg.message)}</div>
          </div>
        </div>
      `;
    }).join('')}
  `;
  
  // Scroll to bottom if was at bottom
  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Setup emoji picker
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
        `<button style="padding: 0.5rem; background: none; border: none; font-size: 1.5rem; cursor: pointer; border-radius: 6px; transition: all 0.1s;" data-emoji="${emoji}" onmouseover="this.style.background='#333';this.style.transform='scale(1.2)'" onmouseout="this.style.background='none';this.style.transform='scale(1)'">${emoji}</button>`
      ).join('');
      
      // Add click handlers
      emojiGrid.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          const input = document.getElementById('chatInput');
          if (input) input.value += btn.dataset.emoji;
          input?.focus();
        };
      });
    }
  }
  
  // Category buttons
  document.querySelectorAll('.emoji-cat').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.emoji-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.cat;
      renderEmojis(currentCategory);
    };
  });
  
  // Toggle picker
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

// Setup Giphy picker
function setupGiphyPicker() {
  const giphyBtn = document.getElementById('giphyBtn');
  const giphyPicker = document.getElementById('giphyPicker');
  const giphySearch = document.getElementById('giphySearch');
  const giphyGrid = document.getElementById('giphyGrid');
  const emojiPicker = document.getElementById('emojiPicker');
  
  let searchTimeout;
  
  async function searchGiphy(query) {
    if (!GIPHY_API_KEY) {
      if (giphyGrid) giphyGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 2rem;">Giphy API key not configured</p>';
      return;
    }
    
    try {
      const endpoint = query 
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=20&rating=pg-13`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=20&rating=pg-13`;
      
      const response = await fetch(endpoint);
      const data = await response.json();
      
      if (data.data && data.data.length > 0 && giphyGrid) {
        giphyGrid.innerHTML = data.data.map(gif => `
          <div style="aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer; transition: all 0.2s; border: 2px solid transparent;" data-url="${gif.images.fixed_height.url}" data-id="${gif.id}" onmouseover="this.style.borderColor='#6366f1';this.style.transform='scale(1.05)'" onmouseout="this.style.borderColor='transparent';this.style.transform='scale(1)'">
            <img src="${gif.images.fixed_height_small.url}" alt="${gif.title}" style="width: 100%; height: 100%; object-fit: cover;" />
          </div>
        `).join('');
        
        // Add click handlers
        giphyGrid.querySelectorAll('div[data-url]').forEach(item => {
          item.onclick = () => {
            sendGiphyMessage(item.dataset.url, item.dataset.id);
            giphyPicker?.classList.add('hidden');
            giphyBtn?.classList.remove('active');
          };
        });
      } else if (giphyGrid) {
        giphyGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 2rem;">No GIFs found</p>';
      }
    } catch (error) {
      console.error('Giphy error:', error);
      if (giphyGrid) giphyGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 2rem;">Failed to load GIFs</p>';
    }
  }
  
  // Search input
  if (giphySearch) {
    giphySearch.oninput = (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchGiphy(e.target.value);
      }, 500);
    };
  }
  
  // Toggle picker
  if (giphyBtn) {
    giphyBtn.onclick = () => {
      giphyPicker?.classList.toggle('hidden');
      emojiPicker?.classList.add('hidden');
      giphyBtn.classList.toggle('active');
      document.getElementById('emojiBtn')?.classList.remove('active');
      
      if (!giphyPicker?.classList.contains('hidden')) {
        searchGiphy(''); // Load trending
      }
    };
  }
}

// Send Giphy message
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
    console.error('Error sending GIF:', error);
  }
}

// Setup chat input
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
        alert(result.error || 'Failed to send message');
      }
    } catch (error) {
      console.error('Error sending message:', error);
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

// Setup reactions
function setupReactions(streamId) {
  const likeBtn = document.getElementById('likeBtn');
  const starBtns = document.querySelectorAll('.star');
  const shareBtn = document.getElementById('shareBtn');
  
  // Like - handled by reaction buttons in live.astro
  // All three reaction buttons (hearts, fire, explosions) trigger likes
  // See triggerReaction() function in live.astro
  
  // Rating
  starBtns.forEach(btn => {
    btn.onmouseenter = () => {
      const rating = parseInt(btn.dataset.rating);
      starBtns.forEach((s, i) => {
        s.classList.toggle('active', i < rating);
      });
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
        console.error('Rating error:', error);
      }
    };
  });
  
  // Share
  if (shareBtn) {
    shareBtn.onclick = () => {
      const url = window.location.href;
      if (navigator.share) {
        navigator.share({
          title: currentStream?.title || 'Live Stream',
          text: `Check out this live stream on Fresh Wax!`,
          url
        });
      } else {
        navigator.clipboard.writeText(url);
        alert('Link copied to clipboard!');
      }
    };
  }
  
  // Load user's reactions
  if (currentUser) {
    loadUserReactions(streamId);
  }
}

// Load user's reactions
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
    console.error('Error loading reactions:', error);
  }
}

// Duration timer
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

// Auth listener
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

// Click outside to close pickers
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

// Initialize
init();
