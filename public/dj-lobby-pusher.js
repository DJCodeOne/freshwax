// public/dj-lobby-pusher.js
// DJ Lobby client - Pusher-based real-time (replaces Firebase onSnapshot)
// Version: 3.2 - January 2026 - Fixed stream end reset

// ==========================================
// PUSHER CONFIGURATION (from window.PUSHER_CONFIG set by Layout.astro)
// ==========================================
// NOTE: Must use getter function - can't read window.PUSHER_CONFIG at module load time
function getPusherConfig() {
  const config = {
    key: window.PUSHER_CONFIG?.key || '',
    cluster: window.PUSHER_CONFIG?.cluster || 'eu'
  };
  console.log('[DJLobby DEBUG] getPusherConfig:', {
    hasConfig: !!window.PUSHER_CONFIG,
    keyLength: config.key.length,
    keyPrefix: config.key.substring(0, 8),
    cluster: config.cluster
  });
  return config;
}

let pusher = null;
let lobbyChannel = null;
let privateChannel = null;
let liveStatusChannel = null;
let currentUser = null;
let userInfo = null;
let onlineDjs = [];
let heartbeatInterval = null;
let dmTargetDj = null;
let dmMessages = [];

// ==========================================
// INITIALIZATION
// ==========================================

export async function initDjLobbyPusher(user, info) {
  currentUser = user;
  userInfo = info;

  console.log('[DJLobby] Initializing Pusher for:', user.uid);

  // Load Pusher script if not loaded
  if (!window.Pusher) {
    console.log('[DJLobby DEBUG] Loading Pusher script...');
    await loadPusherScript();
    console.log('[DJLobby DEBUG] Pusher script loaded');
  }

  // Get Pusher config at runtime (not module load time!)
  const pusherConfig = getPusherConfig();

  if (!pusherConfig.key) {
    console.error('[DJLobby] ERROR: Pusher key not configured!');
    console.error('[DJLobby] window.PUSHER_CONFIG:', window.PUSHER_CONFIG);
    return;
  }

  // Enable Pusher debug logging
  window.Pusher.logToConsole = true;

  // Initialize Pusher
  pusher = new window.Pusher(pusherConfig.key, {
    cluster: pusherConfig.cluster,
    authEndpoint: '/api/dj-lobby/pusher-auth',
    auth: {
      params: {
        user_id: user.uid
      }
    }
  });

  // Add connection state logging
  pusher.connection.bind('state_change', (states) => {
    console.log('[DJLobby DEBUG] Pusher state change:', states.previous, '->', states.current);
  });

  pusher.connection.bind('error', (err) => {
    console.error('[DJLobby DEBUG] Pusher connection error:', err);
  });

  pusher.connection.bind('connected', () => {
    console.log('[DJLobby DEBUG] Pusher connected successfully');
  });

  // Subscribe to public lobby channel
  console.log('[DJLobby DEBUG] Subscribing to dj-lobby channel...');
  lobbyChannel = pusher.subscribe('dj-lobby');

  lobbyChannel.bind('pusher:subscription_succeeded', () => {
    console.log('[DJLobby DEBUG] Successfully subscribed to dj-lobby');
  });

  lobbyChannel.bind('pusher:subscription_error', (error) => {
    console.error('[DJLobby DEBUG] dj-lobby subscription error:', error);
  });

  // Subscribe to private channel for this user (for DMs, takeover notifications)
  console.log('[DJLobby DEBUG] Subscribing to private-dj-' + user.uid);
  privateChannel = pusher.subscribe(`private-dj-${user.uid}`);

  privateChannel.bind('pusher:subscription_succeeded', () => {
    console.log('[DJLobby DEBUG] Successfully subscribed to private channel');
  });

  privateChannel.bind('pusher:subscription_error', (error) => {
    console.error('[DJLobby DEBUG] Private channel subscription error:', error);
  });

  // Subscribe to live-status channel for stream-started/stream-ended events
  console.log('[DJLobby DEBUG] Subscribing to live-status channel...');
  liveStatusChannel = pusher.subscribe('live-status');

  liveStatusChannel.bind('pusher:subscription_succeeded', () => {
    console.log('[DJLobby DEBUG] Successfully subscribed to live-status');
  });

  liveStatusChannel.bind('stream-started', (data) => {
    console.log('[DJLobby] Stream started:', data);
    // Reload stream status to update UI
    if (window.loadStreamStatus) {
      window.loadStreamStatus();
    }
  });

  liveStatusChannel.bind('stream-ended', (data) => {
    console.log('[DJLobby] Stream ended:', data);
    // Check if this is the current user's stream ending
    const isMyStream = data.djId === currentUser?.uid;
    if (isMyStream) {
      console.log('[DJLobby] My stream ended - resetting userIsStreaming');
      // Reset the userIsStreaming flag in the main page context
      if (typeof window.resetUserIsStreaming === 'function') {
        window.resetUserIsStreaming();
      }
    }
    // Reset UI to non-streaming state
    resetStreamUI();
    // Reload stream status to update UI
    if (window.loadStreamStatus) {
      window.loadStreamStatus();
    }
  });

  // Set up event handlers
  setupLobbyEvents();
  setupPrivateEvents();

  // Join the lobby
  await joinLobby();

  // Load initial data
  await loadInitialData();

  // Start heartbeat
  startHeartbeat();

  console.log('[DJLobby] Pusher initialized');
}

async function loadPusherScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.pusher.com/8.2.0/pusher.min.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Reset UI when stream ends
function resetStreamUI() {
  console.log('[DJLobby] Resetting stream UI...');

  // Reset Ready button
  const readyBtn = document.getElementById('setReadyBtn');
  const readyBtnText = document.getElementById('readyBtnText');
  if (readyBtn) {
    readyBtn.classList.remove('is-ready-state', 'is-ready');
    readyBtn.style.background = '';
    readyBtn.disabled = false;
    readyBtn.classList.add('glow');
  }
  if (readyBtnText) {
    readyBtnText.textContent = "I'm Ready";
  }

  // Hide GO LIVE button
  const goLiveBtn = document.getElementById('goLiveBtn');
  if (goLiveBtn) {
    goLiveBtn.classList.add('hidden');
    goLiveBtn.disabled = false;
    const goLiveBtnText = document.getElementById('goLiveBtnText');
    if (goLiveBtnText) goLiveBtnText.textContent = 'GO LIVE!';
  }

  // Reset Lobby End Stream button
  const lobbyEndStreamBtn = document.getElementById('lobbyEndStreamBtn');
  if (lobbyEndStreamBtn) {
    lobbyEndStreamBtn.classList.add('disabled');
    lobbyEndStreamBtn.classList.remove('ending');
    lobbyEndStreamBtn.disabled = true;
    lobbyEndStreamBtn.innerHTML = '<span class="end-icon">⏹</span><span class="end-text">End Stream</span>';
  }

  // Reset status text
  const endStreamStatus = document.getElementById('endStreamStatus');
  if (endStreamStatus) {
    endStreamStatus.textContent = 'No active stream';
    endStreamStatus.classList.remove('live', 'ending');
  }

  // Hide broadcast audio panel
  const broadcastAudioPanel = document.getElementById('broadcastAudioPanel');
  if (broadcastAudioPanel) {
    broadcastAudioPanel.classList.add('hidden');
  }

  // Show stream key section
  const streamKeySection = document.getElementById('streamKeySection');
  if (streamKeySection) {
    streamKeySection.classList.remove('hidden');
  }

  // Collapse preview section
  const previewSection = document.querySelector('.preview-section');
  if (previewSection) {
    previewSection.classList.remove('expanded');
  }

  // Stop relay audio and restore GainNode
  const relayAudio = document.getElementById('relayAudio');
  if (relayAudio) {
    relayAudio.pause();
    relayAudio.currentTime = 0;
  }
  // Restore GainNode volume (was set to 0 when going live)
  if (window.restoreIcecastGain) {
    window.restoreIcecastGain();
  }

  // Stop broadcast meters
  if (typeof window.stopBroadcastMeters === 'function') {
    window.stopBroadcastMeters();
  }
}

// ==========================================
// LOBBY EVENTS (Public channel)
// ==========================================

function setupLobbyEvents() {
  // DJ joined
  lobbyChannel.bind('dj-joined', (data) => {
    console.log('[DJLobby] DJ joined:', data.name);
    
    // Add to local list if not already present
    const existingIndex = onlineDjs.findIndex(dj => dj.id === data.id);
    if (existingIndex === -1) {
      onlineDjs.push(data);
    } else {
      onlineDjs[existingIndex] = { ...onlineDjs[existingIndex], ...data };
    }
    
    updateOnlineDjsUI();
  });
  
  // DJ left
  lobbyChannel.bind('dj-left', (data) => {
    console.log('[DJLobby] DJ left:', data.id);
    onlineDjs = onlineDjs.filter(dj => dj.id !== data.id);
    updateOnlineDjsUI();
  });
  
  // DJ status updated
  lobbyChannel.bind('dj-status', (data) => {
    const dj = onlineDjs.find(d => d.id === data.id);
    if (dj) {
      dj.isReady = data.isReady;
      updateOnlineDjsUI();
    }
  });
  
  // DJ updated
  lobbyChannel.bind('dj-updated', (data) => {
    const dj = onlineDjs.find(d => d.id === data.id);
    if (dj) {
      Object.assign(dj, data);
      updateOnlineDjsUI();
    }
  });
  
  // Chat message - DISABLED: Now using LiveChat component for livestream chat
  // lobbyChannel.bind('chat-message', (data) => {
  //   appendChatMessage(data);
  // });

  // Chat message deleted - DISABLED: Now using LiveChat component
  // lobbyChannel.bind('chat-deleted', (data) => {
  //   const msgEl = document.querySelector(`[data-message-id="${data.id}"]`);
  //   if (msgEl) {
  //     msgEl.remove();
  //   }
  // });
  
  // Takeover events (for lobby visibility)
  lobbyChannel.bind('takeover-requested', (data) => {
    // Could show notification in chat
    console.log('[DJLobby] Takeover requested:', data);
  });
  
  lobbyChannel.bind('takeover-approved', (data) => {
    console.log('[DJLobby] Takeover approved:', data);
  });
}

// ==========================================
// PRIVATE EVENTS (DMs, Takeover notifications)
// ==========================================

function setupPrivateEvents() {
  // Incoming takeover request
  privateChannel.bind('takeover-request', (data) => {
    console.log('[DJLobby] Incoming takeover request:', data);
    showIncomingTakeover(data);
  });
  
  // Takeover approved (when you requested)
  privateChannel.bind('takeover-approved', (data) => {
    console.log('[DJLobby] Your takeover was approved:', data);
    showTakeoverApproved(data);
  });
  
  // Takeover declined
  privateChannel.bind('takeover-declined', (data) => {
    console.log('[DJLobby] Your takeover was declined');
    stopTakeoverCountdown();
    alert('Your takeover request was declined.');
    document.getElementById('takeoverPending')?.classList.add('hidden');
    document.getElementById('requestTakeoverBtn')?.classList.remove('hidden');
  });
  
  // Takeover cancelled
  privateChannel.bind('takeover-cancelled', (data) => {
    console.log('[DJLobby] Takeover request cancelled');
    stopTakeoverCountdown();
    stopIncomingTakeoverCountdown();
    hideIncomingTakeover();
  });
  
  // DM message
  privateChannel.bind('dm-message', (data) => {
    console.log('[DJLobby] DM received:', data);
    
    // Check if this is for the currently open DM conversation
    if (dmTargetDj && (data.senderId === dmTargetDj.id || data.receiverId === dmTargetDj.id)) {
      // Add to current conversation
      dmMessages.push(data);
      renderDmMessages();
    }
  });
  
  // DM notification (when not in that conversation)
  privateChannel.bind('dm-notification', (data) => {
    console.log('[DJLobby] DM notification:', data);
    
    // Show notification if DM modal is closed or chatting with someone else
    const dmModalVisible = !document.getElementById('dmModal')?.classList.contains('hidden');
    const chattingWithSender = dmTargetDj?.id === data.senderId;
    
    if (!dmModalVisible || !chattingWithSender) {
      showDmNotification(data.senderId, data.senderName, data.preview);
    }
  });
  
  // DM conversation cleared
  privateChannel.bind('dm-cleared', (data) => {
    if (dmTargetDj?.id === data.targetId) {
      dmMessages = [];
      renderDmMessages();
    }
  });
}

// ==========================================
// PRESENCE (Join/Leave/Heartbeat)
// ==========================================

async function joinLobby() {
  console.log('[DJLobby DEBUG] joinLobby called');
  try {
    // Get fresh idToken for Firebase write
    const idToken = await currentUser.getIdToken();
    console.log('[DJLobby DEBUG] Got idToken, length:', idToken?.length);

    const djData = {
      id: currentUser.uid,
      odamiMa: currentUser.uid,
      name: userInfo.name,
      avatar: userInfo.avatar,
      avatarLetter: userInfo.firstName?.charAt(0) || userInfo.name?.charAt(0) || 'D',
      isReady: false
    };

    console.log('[DJLobby DEBUG] Calling /api/dj-lobby/presence POST with:', djData);

    const response = await fetch('/api/dj-lobby/presence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        action: 'join',
        userId: currentUser.uid,
        name: userInfo.name,
        avatar: userInfo.avatar,
        avatarLetter: djData.avatarLetter,
        isReady: false
      })
    });

    // Add self to online DJs list immediately (in case Pusher event arrives late)
    const existingIndex = onlineDjs.findIndex(dj => dj.id === currentUser.uid);
    if (existingIndex === -1) {
      onlineDjs.push(djData);
    } else {
      onlineDjs[existingIndex] = { ...onlineDjs[existingIndex], ...djData };
    }
    updateOnlineDjsUI();

    console.log('[DJLobby] Joined lobby');
  } catch (error) {
    console.error('[DJLobby] Failed to join:', error);
  }
}

async function leaveLobby() {
  try {
    const idToken = await currentUser.getIdToken();

    await fetch('/api/dj-lobby/presence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        action: 'leave',
        userId: currentUser.uid
      })
    });
    console.log('[DJLobby] Left lobby');
  } catch (error) {
    console.error('[DJLobby] Failed to leave:', error);
  }
}

function startHeartbeat() {
  // Send heartbeat every 30 seconds
  heartbeatInterval = setInterval(async () => {
    try {
      const idToken = await currentUser.getIdToken();

      await fetch('/api/dj-lobby/presence', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          action: 'heartbeat',
          userId: currentUser.uid,
          isReady: document.getElementById('readyToggle')?.checked || false
        })
      });
    } catch (error) {
      console.error('[DJLobby] Heartbeat failed:', error);
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ==========================================
// INITIAL DATA LOAD
// ==========================================

async function loadInitialData() {
  await Promise.all([
    loadOnlineDjs(),
    // loadChatHistory() - DISABLED: Now using LiveChat component for livestream chat
    checkTakeoverStatus()
  ]);
}

async function loadOnlineDjs() {
  console.log('[DJLobby DEBUG] loadOnlineDjs called');
  try {
    const response = await fetch('/api/dj-lobby/presence');
    console.log('[DJLobby DEBUG] loadOnlineDjs response status:', response.status);

    const result = await response.json();
    console.log('[DJLobby DEBUG] loadOnlineDjs result:', result);

    if (result.success) {
      onlineDjs = result.djs;
      updateOnlineDjsUI();
    } else {
      console.error('[DJLobby DEBUG] loadOnlineDjs failed:', result.error);
    }
  } catch (error) {
    console.error('[DJLobby] Failed to load online DJs:', error);
  }
}

async function loadChatHistory() {
  try {
    const response = await fetch('/api/dj-lobby/chat?limit=20');
    const result = await response.json();
    
    if (result.success) {
      renderChatHistory(result.messages);
    }
  } catch (error) {
    console.error('[DJLobby] Failed to load chat:', error);
  }
}

async function checkTakeoverStatus() {
  try {
    const response = await fetch(`/api/dj-lobby/takeover?userId=${currentUser.uid}`);
    const result = await response.json();
    
    if (result.success) {
      if (result.incoming?.status === 'pending') {
        showIncomingTakeover(result.incoming);
      }
      if (result.outgoing?.status === 'pending') {
        // Show pending UI
        document.getElementById('takeoverPending')?.classList.remove('hidden');
        document.getElementById('requestTakeoverBtn')?.classList.add('hidden');
      } else if (result.outgoing?.status === 'approved') {
        showTakeoverApproved(result.outgoing);
      }
    }
  } catch (error) {
    console.error('[DJLobby] Failed to check takeover:', error);
  }
}

// ==========================================
// UI UPDATES
// ==========================================

function updateOnlineDjsUI() {
  const countEl = document.getElementById('onlineDjCount');
  const listEl = document.getElementById('djsList');
  
  if (countEl) {
    countEl.textContent = onlineDjs.length;
  }
  
  if (!listEl) return;
  
  if (onlineDjs.length === 0) {
    listEl.innerHTML = '<p class="empty-state">No DJs online yet</p>';
    return;
  }
  
  listEl.innerHTML = onlineDjs.map(dj => {
    const isMe = dj.id === currentUser?.uid || dj.odamiMa === currentUser?.uid;
    const isReady = dj.isReady === true;
    const avatarLetter = dj.avatarLetter || (dj.name ? dj.name.charAt(0).toUpperCase() : 'D');
    const hasAvatar = dj.avatar && dj.avatar !== '/place-holder.webp' && dj.avatar !== '/logo.webp';
    
    return `
      <div class="dj-item ${isReady ? 'is-ready' : ''}" data-dj-id="${dj.id || dj.odamiMa}">
        ${hasAvatar 
          ? `<img src="${dj.avatar}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><span class="dj-avatar-letter" style="display:none;">${avatarLetter}</span>`
          : `<span class="dj-avatar-letter">${avatarLetter}</span>`
        }
        <span>${dj.name}${isMe ? ' (you)' : ''}</span>
        ${isReady ? '<span class="ready-badge">READY</span>' : ''}
      </div>
    `;
  }).join('');
}

function renderChatHistory(messages) {
  // DISABLED: Now using LiveChat component
  return;
}

function appendChatMessage(msg) {
  // DISABLED: Now using LiveChat component
  return;
  const container = document.getElementById('chatMessages');
  if (!container) return;
  
  // Remove welcome message if present
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  
  container.insertAdjacentHTML('beforeend', createChatMessageHTML(msg));
  container.scrollTop = container.scrollHeight;
}

function createChatMessageHTML(msg) {
  const time = msg.createdAt 
    ? new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';
  
  return `
    <div class="chat-message" data-message-id="${msg.id}">
      <div class="chat-message-content">
        <div class="chat-message-header">
          <span class="chat-message-name">${escapeHtml(msg.name || 'DJ')}</span>
          <span class="chat-message-time">${time}</span>
        </div>
        <div class="chat-message-text">${escapeHtml(msg.text)}</div>
      </div>
    </div>
  `;
}

// ==========================================
// CHAT
// ==========================================

export async function sendChatMessage(text) {
  if (!text?.trim() || !currentUser || !userInfo) return false;
  
  try {
    const response = await fetch('/api/dj-lobby/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.uid,
        name: userInfo.name,
        text: text.trim(),
        avatar: userInfo.avatar
      })
    });
    
    const result = await response.json();
    
    if (!result.success) {
      alert(result.error || 'Failed to send message');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('[DJLobby] Send chat error:', error);
    return false;
  }
}

// ==========================================
// TAKEOVER
// ==========================================

// Takeover countdown state
let takeoverCountdownInterval = null;
let incomingTakeoverCountdownInterval = null;
const TAKEOVER_TIMEOUT_SECONDS = 300; // 5 minutes

export async function requestTakeover(targetDjId, targetDjName) {
  if (!currentUser || !userInfo) return false;

  try {
    const response = await fetch('/api/dj-lobby/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'request',
        requesterId: currentUser.uid,
        requesterName: userInfo.name,
        requesterAvatar: userInfo.avatar,
        targetDjId,
        targetDjName
      })
    });

    const result = await response.json();

    if (result.success) {
      document.getElementById('takeoverPending')?.classList.remove('hidden');
      document.getElementById('requestTakeoverBtn')?.classList.add('hidden');

      // Start countdown timer
      startTakeoverCountdown();

      return true;
    } else {
      alert(result.error || 'Failed to request takeover');
      return false;
    }
  } catch (error) {
    console.error('[DJLobby] Takeover request error:', error);
    return false;
  }
}

function startTakeoverCountdown() {
  // Clear any existing countdown
  if (takeoverCountdownInterval) {
    clearInterval(takeoverCountdownInterval);
  }

  let secondsRemaining = TAKEOVER_TIMEOUT_SECONDS;
  const countdownEl = document.getElementById('takeoverCountdown');

  const updateCountdown = () => {
    if (countdownEl) {
      const mins = Math.floor(secondsRemaining / 60);
      const secs = secondsRemaining % 60;
      countdownEl.textContent = `(${mins}:${secs.toString().padStart(2, '0')})`;
    }

    secondsRemaining--;

    if (secondsRemaining < 0) {
      // Timeout - reset UI
      clearInterval(takeoverCountdownInterval);
      takeoverCountdownInterval = null;
      document.getElementById('takeoverPending')?.classList.add('hidden');
      document.getElementById('requestTakeoverBtn')?.classList.remove('hidden');
      if (countdownEl) countdownEl.textContent = '';
      alert('Takeover request timed out. The DJ did not respond.');
    }
  };

  updateCountdown();
  takeoverCountdownInterval = setInterval(updateCountdown, 1000);
}

function stopTakeoverCountdown() {
  if (takeoverCountdownInterval) {
    clearInterval(takeoverCountdownInterval);
    takeoverCountdownInterval = null;
  }
  const countdownEl = document.getElementById('takeoverCountdown');
  if (countdownEl) countdownEl.textContent = '';
}

export async function approveTakeover(requesterId, streamKey, serverUrl) {
  try {
    const response = await fetch('/api/dj-lobby/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        requesterId,
        streamKey,
        serverUrl
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      hideIncomingTakeover();
      return true;
    }
    return false;
  } catch (error) {
    console.error('[DJLobby] Approve takeover error:', error);
    return false;
  }
}

export async function declineTakeover(requesterId) {
  try {
    const response = await fetch('/api/dj-lobby/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'decline',
        requesterId
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      hideIncomingTakeover();
      return true;
    }
    return false;
  } catch (error) {
    console.error('[DJLobby] Decline takeover error:', error);
    return false;
  }
}

function showIncomingTakeover(data) {
  const div = document.getElementById('incomingTakeover');
  if (!div) return;

  const nameEl = document.getElementById('incomingDjName');
  const avatarEl = document.getElementById('incomingDjAvatar');

  if (nameEl) nameEl.textContent = data.requesterName || 'A DJ';
  if (avatarEl) avatarEl.src = data.requesterAvatar || '/logo.webp';

  div.dataset.requesterId = data.requesterId;
  div.classList.remove('hidden');

  // Start countdown for incoming request
  startIncomingTakeoverCountdown();
}

function startIncomingTakeoverCountdown() {
  // Clear any existing countdown
  if (incomingTakeoverCountdownInterval) {
    clearInterval(incomingTakeoverCountdownInterval);
  }

  let secondsRemaining = TAKEOVER_TIMEOUT_SECONDS;

  // Create or find countdown element
  let countdownEl = document.getElementById('incomingTakeoverCountdown');
  if (!countdownEl) {
    const badge = document.querySelector('.incoming-badge');
    if (badge) {
      countdownEl = document.createElement('span');
      countdownEl.id = 'incomingTakeoverCountdown';
      countdownEl.style.marginLeft = '8px';
      countdownEl.style.fontSize = '0.85em';
      countdownEl.style.opacity = '0.8';
      badge.appendChild(countdownEl);
    }
  }

  const updateCountdown = () => {
    if (countdownEl) {
      const mins = Math.floor(secondsRemaining / 60);
      const secs = secondsRemaining % 60;
      countdownEl.textContent = `(${mins}:${secs.toString().padStart(2, '0')})`;
    }

    secondsRemaining--;

    if (secondsRemaining < 0) {
      // Timeout - auto-decline
      clearInterval(incomingTakeoverCountdownInterval);
      incomingTakeoverCountdownInterval = null;
      hideIncomingTakeover();
    }
  };

  updateCountdown();
  incomingTakeoverCountdownInterval = setInterval(updateCountdown, 1000);
}

function stopIncomingTakeoverCountdown() {
  if (incomingTakeoverCountdownInterval) {
    clearInterval(incomingTakeoverCountdownInterval);
    incomingTakeoverCountdownInterval = null;
  }
  const countdownEl = document.getElementById('incomingTakeoverCountdown');
  if (countdownEl) countdownEl.textContent = '';
}

function hideIncomingTakeover() {
  document.getElementById('incomingTakeover')?.classList.add('hidden');
  stopIncomingTakeoverCountdown();
}

function showTakeoverApproved(data) {
  // Stop any running countdowns
  stopTakeoverCountdown();
  stopIncomingTakeoverCountdown();

  const div = document.getElementById('takeoverApproved');
  if (!div) return;

  const serverEl = document.getElementById('takeoverServerUrl');
  const keyEl = document.getElementById('takeoverStreamKey');

  if (serverEl) serverEl.textContent = data.serverUrl || 'rtmp://stream.freshwax.co.uk/live';
  if (keyEl) keyEl.textContent = data.streamKey || '-';

  div.classList.remove('hidden');
  document.getElementById('takeoverRequest')?.classList.add('hidden');
  document.getElementById('takeoverPending')?.classList.add('hidden');
  document.getElementById('noStreamTakeover')?.classList.add('hidden');
}

// ==========================================
// DIRECT MESSAGES
// ==========================================

export async function openDmConversation(targetDj) {
  dmTargetDj = targetDj;
  dmMessages = [];
  
  // Show DM modal
  document.getElementById('dmModal')?.classList.remove('hidden');
  document.getElementById('dmSelectView')?.classList.add('hidden');
  document.getElementById('dmChatView')?.classList.remove('hidden');
  
  // Update header
  const headerName = document.getElementById('dmTargetName');
  if (headerName) headerName.textContent = targetDj.name;
  
  // Load conversation history
  try {
    const response = await fetch(`/api/dj-lobby/dm?userId=${currentUser.uid}&targetId=${targetDj.id}`);
    const result = await response.json();
    
    if (result.success) {
      dmMessages = result.messages;
      renderDmMessages();
    }
  } catch (error) {
    console.error('[DJLobby] Failed to load DM history:', error);
  }
}

export async function sendDm(text) {
  if (!text?.trim() || !currentUser || !userInfo || !dmTargetDj) return false;
  
  try {
    const response = await fetch('/api/dj-lobby/dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderId: currentUser.uid,
        senderName: userInfo.name,
        receiverId: dmTargetDj.id,
        receiverName: dmTargetDj.name,
        text: text.trim()
      })
    });
    
    const result = await response.json();
    return result.success;
  } catch (error) {
    console.error('[DJLobby] Send DM error:', error);
    return false;
  }
}

function renderDmMessages() {
  const container = document.getElementById('dmMessages');
  if (!container) return;
  
  if (dmMessages.length === 0) {
    container.innerHTML = `
      <div class="dm-welcome">
        <p>Start a private conversation</p>
        <p class="hint">Only you and this DJ can see these messages.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = dmMessages.map(msg => {
    const isSent = msg.senderId === currentUser?.uid;
    const time = msg.createdAt 
      ? new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '';
    
    return `
      <div class="dm-message ${isSent ? 'sent' : ''}">
        <div class="dm-message-content">
          <div class="dm-message-name">${isSent ? 'You' : escapeHtml(msg.senderName || 'DJ')}</div>
          <div class="dm-message-text">${escapeHtml(msg.text)}</div>
          <div class="dm-message-time">${time}</div>
        </div>
      </div>
    `;
  }).join('');
  
  container.scrollTop = container.scrollHeight;
}

function showDmNotification(senderId, senderName, message) {
  const notif = document.getElementById('dmNotification');
  const text = document.getElementById('dmNotifText');
  
  if (!notif || !text) return;
  
  text.textContent = `New DM from ${senderName}`;
  notif.dataset.senderId = senderId;
  notif.dataset.senderName = senderName;
  notif.classList.remove('hidden');
  
  setTimeout(() => {
    notif.classList.add('hidden');
  }, 10000);
}

export function closeDmModal() {
  dmTargetDj = null;
  dmMessages = [];
  document.getElementById('dmModal')?.classList.add('hidden');
}

// ==========================================
// CLEANUP
// ==========================================

export async function cleanup() {
  console.log('[DJLobby] Cleaning up...');
  
  stopHeartbeat();
  
  // Leave lobby
  await leaveLobby();
  
  // Unsubscribe from Pusher channels
  if (lobbyChannel) {
    pusher.unsubscribe('dj-lobby');
    lobbyChannel = null;
  }
  
  if (privateChannel && currentUser) {
    pusher.unsubscribe(`private-dj-${currentUser.uid}`);
    privateChannel = null;
  }

  if (liveStatusChannel) {
    pusher.unsubscribe('live-status');
    liveStatusChannel = null;
  }

  // Disconnect Pusher
  if (pusher) {
    pusher.disconnect();
    pusher = null;
  }
  
  currentUser = null;
  userInfo = null;
  onlineDjs = [];
}

// ==========================================
// UTILITIES
// ==========================================

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Export online DJs for DM list
export function getOnlineDjs() {
  return onlineDjs.filter(dj => dj.id !== currentUser?.uid && dj.odamiMa !== currentUser?.uid);
}

// Set up cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    // Use sendBeacon for reliable cleanup
    if (currentUser) {
      navigator.sendBeacon('/api/dj-lobby/presence', JSON.stringify({
        action: 'leave',
        userId: currentUser.uid
      }));
    }
  });
  
  // Also handle visibility change (tab hidden)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && currentUser) {
      // Send heartbeat with reduced frequency when hidden
      console.log('[DJLobby] Tab hidden');
    }
  });
}
