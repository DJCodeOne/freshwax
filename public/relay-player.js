// public/relay-player.js
// Handles external radio relay playback and discovery

// State
let currentRelay = null;
let relayAudioElement = null;
let freshWaxPriority = true; // Always prioritize Fresh Wax DJs
let checkInterval = null;

// Initialize relay system
export function initRelaySystem() {
  // Create hidden audio element for relay streams
  relayAudioElement = document.createElement('audio');
  relayAudioElement.id = 'relayAudio';
  relayAudioElement.preload = 'none';
  document.body.appendChild(relayAudioElement);
  
  // Setup relay audio events
  relayAudioElement.addEventListener('play', () => {
    updateRelayUI(true);
  });
  
  relayAudioElement.addEventListener('pause', () => {
    updateRelayUI(false);
  });
  
  relayAudioElement.addEventListener('error', (e) => {
    console.error('[Relay] Audio error:', e);
    showRelayError('Stream connection lost. Try another station.');
  });
  
  // Start checking for Fresh Wax DJ periodically when playing relay
  startFreshWaxCheck();
}

// Start periodic check for Fresh Wax DJs
function startFreshWaxCheck() {
  // Check every 60 seconds if a Fresh Wax DJ has gone live (was 30s)
  checkInterval = setInterval(async () => {
    if (!currentRelay) return; // Only check when playing relay
    
    try {
      const response = await fetch('/api/livestream/status');
      const result = await response.json();
      
      if (result.success && result.isLive && result.primaryStream) {
        // Fresh Wax DJ is live - switch immediately
        console.log('[Relay] Fresh Wax DJ detected, switching...');
        stopRelay();
        
        // Trigger the main player to load the Fresh Wax stream
        if (window.showLiveStream) {
          window.showLiveStream(result.primaryStream);
        } else {
          // Fallback: reload page
          location.reload();
        }
      }
    } catch (error) {
      console.error('[Relay] Error checking Fresh Wax status:', error);
    }
  }, 60000);
}

// Check what's playing on external stations
export async function checkRelays() {
  const container = document.getElementById('relayDiscovery');
  const list = document.getElementById('relayList');
  const checkBtn = document.getElementById('checkRelaysBtn');
  
  if (checkBtn) {
    checkBtn.disabled = true;
    checkBtn.innerHTML = '<span class="spinner"></span> Checking...';
  }
  
  try {
    const response = await fetch('/api/livestream/check-relays');
    const result = await response.json();
    
    if (result.success) {
      renderRelayList(result.relays);
      container?.classList.remove('hidden');
    } else {
      showRelayError(result.error || 'Failed to check relay sources');
    }
  } catch (error) {
    console.error('[Relay] Error checking relays:', error);
    showRelayError('Network error checking relay sources');
  } finally {
    if (checkBtn) {
      checkBtn.disabled = false;
      checkBtn.innerHTML = '🔍 Check What\'s Playing';
    }
  }
}

// Render relay list
function renderRelayList(relays) {
  const list = document.getElementById('relayList');
  if (!list) return;
  
  if (relays.length === 0) {
    list.innerHTML = '<div class="relay-empty">No relay sources configured</div>';
    return;
  }
  
  list.innerHTML = relays.map(relay => `
    <div class="relay-item ${relay.isLive ? 'is-live' : ''} ${currentRelay?.id === relay.id ? 'active' : ''}">
      <div class="relay-logo">
        ${relay.logoUrl 
          ? `<img src="${relay.logoUrl}" alt="${relay.name}" />`
          : '<span>📻</span>'
        }
      </div>
      <div class="relay-info">
        <div class="relay-name">${relay.name}</div>
        <div class="relay-meta">
          ${relay.isLive 
            ? `<span class="relay-live">🟢 Live</span>` 
            : `<span class="relay-offline">⚫ Offline</span>`
          }
          ${relay.nowPlaying ? `<span class="now-playing">🎵 ${relay.nowPlaying}</span>` : ''}
        </div>
        <div class="relay-genre">${relay.genre || ''}</div>
      </div>
      <div class="relay-actions">
        ${currentRelay?.id === relay.id
          ? `<button class="relay-btn stop" onclick="window.stopRelay()">⏹ Stop</button>`
          : `<button class="relay-btn play" onclick="window.playRelay('${relay.id}')" ${!relay.isLive && relay.checkMethod !== 'none' ? 'disabled' : ''}>▶ Listen</button>`
        }
        ${relay.websiteUrl ? `<a href="${relay.websiteUrl}" target="_blank" class="relay-link">🔗</a>` : ''}
      </div>
    </div>
  `).join('');
}

// Play a relay stream
export async function playRelay(relayId) {
  try {
    // Fetch relay details
    const response = await fetch(`/api/livestream/relay-sources?id=${relayId}`);
    const result = await response.json();
    
    if (!result.success || !result.source) {
      showRelayError('Relay source not found');
      return;
    }
    
    const relay = result.source;
    
    // Stop any current playback
    stopRelay();
    
    // Stop main player if playing
    const mainVideo = document.getElementById('hlsVideoElement');
    const mainAudio = document.getElementById('audioElement');
    if (mainVideo) mainVideo.pause();
    if (mainAudio) mainAudio.pause();
    
    // Setup and play relay
    currentRelay = relay;
    relayAudioElement.src = relay.streamUrl;
    
    // Show relay player UI
    showRelayPlayer(relay);
    
    // Attempt playback
    try {
      await relayAudioElement.play();
    } catch (playError) {
      // Autoplay might be blocked - show play button
      console.warn('[Relay] Autoplay blocked:', playError);
      showRelayPlayPrompt();
    }
    
    // Refresh relay list to show active state
    const relays = Array.from(document.querySelectorAll('.relay-item'));
    relays.forEach(item => item.classList.remove('active'));
    document.querySelector(`.relay-item[data-id="${relayId}"]`)?.classList.add('active');
    
    // Re-render list to update buttons
    checkRelays();
    
  } catch (error) {
    console.error('[Relay] Error playing relay:', error);
    showRelayError('Failed to connect to stream');
  }
}

// Stop relay playback
export function stopRelay() {
  if (relayAudioElement) {
    relayAudioElement.pause();
    relayAudioElement.src = '';
  }
  
  currentRelay = null;
  hideRelayPlayer();
  
  // Refresh list
  checkRelays();
}

// Show relay player overlay
function showRelayPlayer(relay) {
  const player = document.getElementById('relayPlayer');
  if (!player) return;
  
  player.innerHTML = `
    <div class="relay-player-content">
      <div class="relay-player-info">
        ${relay.logoUrl 
          ? `<img src="${relay.logoUrl}" alt="${relay.name}" class="relay-player-logo" />`
          : '<div class="relay-player-logo placeholder">📻</div>'
        }
        <div>
          <div class="relay-player-label">NOW RELAYING</div>
          <div class="relay-player-name">${relay.name}</div>
          <div class="relay-player-genre">${relay.genre || 'External Radio'}</div>
        </div>
      </div>
      <div class="relay-player-controls">
        <button id="relayPlayPauseBtn" class="relay-control-btn" onclick="window.toggleRelayPlayback()">
          <span class="play-icon hidden">▶</span>
          <span class="pause-icon">⏸</span>
        </button>
        <button class="relay-stop-btn" onclick="window.stopRelay()">Stop Relay</button>
      </div>
      ${relay.websiteUrl ? `<a href="${relay.websiteUrl}" target="_blank" class="relay-source-link">Visit ${relay.name} →</a>` : ''}
    </div>
    <div class="relay-priority-notice">
      <span>⚡</span> Fresh Wax DJs have priority - auto-switching when live
    </div>
  `;
  
  player.classList.remove('hidden');
  
  // Hide the offline overlay
  document.getElementById('offlineOverlay')?.classList.add('hidden');
}

// Hide relay player
function hideRelayPlayer() {
  const player = document.getElementById('relayPlayer');
  if (player) {
    player.classList.add('hidden');
  }
  
  // Show offline overlay if no Fresh Wax stream
  document.getElementById('offlineOverlay')?.classList.remove('hidden');
}

// Toggle relay playback
export function toggleRelayPlayback() {
  if (!relayAudioElement) return;
  
  if (relayAudioElement.paused) {
    relayAudioElement.play();
  } else {
    relayAudioElement.pause();
  }
}

// Update relay player UI based on play state
function updateRelayUI(isPlaying) {
  const playIcon = document.querySelector('.relay-control-btn .play-icon');
  const pauseIcon = document.querySelector('.relay-control-btn .pause-icon');
  
  if (playIcon && pauseIcon) {
    playIcon.classList.toggle('hidden', isPlaying);
    pauseIcon.classList.toggle('hidden', !isPlaying);
  }
}

// Show play prompt for autoplay blocked
function showRelayPlayPrompt() {
  const player = document.getElementById('relayPlayer');
  if (!player) return;
  
  const prompt = document.createElement('div');
  prompt.className = 'relay-play-prompt';
  prompt.innerHTML = `
    <button onclick="this.parentElement.remove(); document.getElementById('relayAudio').play();">
      ▶ Tap to Play
    </button>
  `;
  player.querySelector('.relay-player-content')?.appendChild(prompt);
}

// Show relay error
function showRelayError(message) {
  const container = document.getElementById('relayDiscovery');
  if (!container) return;
  
  const error = document.createElement('div');
  error.className = 'relay-error';
  error.innerHTML = `<span>⚠️</span> ${message}`;
  
  container.querySelector('.relay-error')?.remove();
  container.prepend(error);
  
  setTimeout(() => error.remove(), 5000);
}

// Expose functions globally
window.playRelay = playRelay;
window.stopRelay = stopRelay;
window.checkRelays = checkRelays;
window.toggleRelayPlayback = toggleRelayPlayback;

// Auto-init when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRelaySystem);
} else {
  initRelaySystem();
}
