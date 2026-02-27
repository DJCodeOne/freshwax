// public/live/lobby.js
// Live page — DJ lobby panel, ready state, takeover, grace period

var escapeHtml = null;
var isDjReady = false;
var slotExpired = false;
var GRACE_PERIOD_SECONDS = 180; // 3 minutes
var takeoverPollInterval = null;
var takeoverFallbackInterval = null;

export function initLobby(deps) {
  escapeHtml = deps.escapeHtml;

  // Ready button
  var readyBtn = document.getElementById('readyBtn');
  if (readyBtn) readyBtn.addEventListener('click', function() { setDjReady(deps); });

  // Leave lobby
  var leaveLobbyBtn = document.getElementById('leaveLobbyBtn');
  if (leaveLobbyBtn) {
    leaveLobbyBtn.addEventListener('click', function() {
      var panel = document.getElementById('lobbyPanel');
      if (panel) panel.classList.add('hidden');
    });
  }

  // Copy buttons
  var copyLobbyBtn = document.getElementById('copyLobbyStreamKeyBtn');
  if (copyLobbyBtn) copyLobbyBtn.addEventListener('click', function() { copyLobbyStreamKey(); });

  var copyRtmpBtn = document.getElementById('copyRtmpUrlBtn');
  if (copyRtmpBtn) copyRtmpBtn.addEventListener('click', function() { copyRtmpUrl(); });

  var copyTakeoverBtn = document.getElementById('copyTakeoverKeyBtn');
  if (copyTakeoverBtn) copyTakeoverBtn.addEventListener('click', function() { copyTakeoverKey(); });

  var copyTakeoverRtmpBtn = document.getElementById('copyTakeoverRtmpBtn');
  if (copyTakeoverRtmpBtn) copyTakeoverRtmpBtn.addEventListener('click', function() { copyRtmpUrl(); });

  // Expose copy functions globally
  window.copyTakeoverKey = copyTakeoverKey;
  window.copyLobbyStreamKey = copyLobbyStreamKey;
  window.copyRtmpUrl = copyRtmpUrl;
}

export function showLobbyPanel(slot, deps) {
  var panel = document.getElementById('lobbyPanel');
  if (!panel) return;

  // Reset lobby state when entering
  resetLobbyState();

  panel.classList.remove('hidden');
  var slotTimeEl = document.getElementById('lobbySlotTime');
  if (slotTimeEl) slotTimeEl.textContent = deps.formatTime(slot.startTime) + ' - ' + deps.formatTime(slot.endTime);
  var keyEl = document.getElementById('lobbyStreamKey');
  if (keyEl) keyEl.textContent = slot.streamKey || 'Loading...';

  updateLobbyCountdown(slot, deps);
  checkForTakeoverOption(slot, deps);
}

export function subscribeToIncomingTakeover(deps) {
  var currentUser = deps.getCurrentUser();
  var userInfo = deps.getUserInfo();
  if (!currentUser || !(userInfo && userInfo.isDj)) return;

  // Wait for Pusher to be available
  var waitForPusher = function() {
    return new Promise(function(resolve) {
      if (window.Pusher) return resolve();
      var check = setInterval(function() {
        if (window.Pusher) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(function() { clearInterval(check); resolve(); }, 5000);
    });
  };

  waitForPusher().then(async function() {
    if (!window.Pusher) {
      console.warn('[Takeover] Pusher not available, falling back to polling');
      takeoverFallbackInterval = setInterval(async function() {
        var user = deps.getCurrentUser();
        if (!user) return;
        try {
          var response = await fetch('/api/dj-lobby/takeover/?userId=' + user.uid);
          if (!response.ok) return;
          var result = await response.json();
          if (result.success && result.incoming && result.incoming.status === 'pending') {
            showTakeoverNotification(result.incoming);
          } else {
            hideTakeoverNotification();
          }
        } catch (e) { console.warn('[Takeover] Poll error:', e); }
      }, 10000);
      return;
    }

    // Subscribe to private channel for takeover notifications
    var user = deps.getCurrentUser();
    var PUSHER_KEY = (window.PUSHER_CONFIG && window.PUSHER_CONFIG.key) || '';
    var PUSHER_CLUSTER = (window.PUSHER_CONFIG && window.PUSHER_CONFIG.cluster) || 'eu';

    var djAuthToken = null;
    try { djAuthToken = await user.getIdToken(); } catch (e) { /* ignore */ }
    if (!djAuthToken) {
      console.warn('[Takeover] No auth token, skipping Pusher subscription');
      return;
    }

    var pusher = new window.Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      authEndpoint: '/api/dj-lobby/pusher-auth/',
      auth: {
        headers: { 'Authorization': 'Bearer ' + djAuthToken },
        params: { user_id: user.uid }
      }
    });

    var privateChannel = pusher.subscribe('private-dj-' + user.uid);

    privateChannel.bind('takeover-request', function(data) {
      showTakeoverNotification(data);
    });

    privateChannel.bind('takeover-cancelled', function() {
      hideTakeoverNotification();
    });
  });
}

export function setupTakeoverActions(deps) {
  var acceptBtn = document.getElementById('acceptIncomingTakeoverBtn');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', async function() {
      var notification = document.getElementById('incomingTakeoverNotification');
      var requesterId = notification && notification.dataset.requesterId;
      var currentUser = deps.getCurrentUser();

      if (!requesterId || !currentUser) return;

      try {
        var token = await currentUser.getIdToken();
        // First get stream key
        var keyResponse = await fetch('/api/livestream/slots/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ action: 'getStreamKey', djId: currentUser.uid })
        });
        if (!keyResponse.ok) {
          alert('Failed to retrieve stream key');
          return;
        }
        var keyResult = await keyResponse.json();

        // Approve takeover via API
        var approveResponse = await fetch('/api/dj-lobby/takeover/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            action: 'approve',
            requesterId: currentUser.uid,
            streamKey: keyResult.streamKey || 'Contact admin for key',
            serverUrl: keyResult.serverUrl || 'rtmp://rtmp.freshwax.co.uk/live'
          })
        });
        if (!approveResponse.ok) {
          alert('Failed to approve takeover');
          return;
        }
        var approveResult = await approveResponse.json();

        if (approveResult.success) {
          notification.classList.add('hidden');
          alert('Takeover approved! Stream key has been shared.');
        } else {
          alert('Failed to accept takeover: ' + (approveResult.error || 'Unknown error'));
        }
      } catch (e) {
        console.error('Accept takeover error:', e);
        alert('Failed to accept takeover');
      }
    });
  }

  var declineBtn = document.getElementById('declineIncomingTakeoverBtn');
  if (declineBtn) {
    declineBtn.addEventListener('click', async function() {
      var notification = document.getElementById('incomingTakeoverNotification');
      var requesterId = notification && notification.dataset.requesterId;
      var currentUser = deps.getCurrentUser();

      if (!requesterId || !currentUser) return;

      try {
        var token = await currentUser.getIdToken();
        var response = await fetch('/api/dj-lobby/takeover/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            action: 'decline',
            requesterId: currentUser.uid
          })
        });
        if (!response.ok) return;
        var result = await response.json();
        if (result.success) {
          notification.classList.add('hidden');
        }
      } catch (e) {
        console.error('Decline takeover error:', e);
      }
    });
  }

  // Request takeover button
  var requestBtn = document.getElementById('requestTakeoverBtn');
  if (requestBtn) {
    requestBtn.addEventListener('click', async function() {
      var takeoverSection = document.getElementById('takeoverSection');
      var slotId = takeoverSection && takeoverSection.dataset.slotId;
      var currentUser = deps.getCurrentUser();
      var userInfo = deps.getUserInfo();

      if (!slotId || !currentUser) {
        alert('Please log in to request a takeover');
        return;
      }

      requestBtn.disabled = true;
      requestBtn.innerHTML = '<span>Sending request...</span>';

      try {
        var response = await fetch('/api/livestream/slots/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'requestTakeover',
            slotId: slotId,
            requesterId: currentUser.uid,
            requesterName: (userInfo && (userInfo.name || userInfo.displayName)) || 'DJ',
            requesterAvatar: (userInfo && userInfo.avatarUrl) || null
          })
        });

        if (!response.ok) throw new Error('Takeover request failed');
        var result = await response.json();

        if (result.success) {
          showTakeoverPending();
        } else {
          alert(result.error || 'Failed to send takeover request');
          requestBtn.disabled = false;
          requestBtn.innerHTML = '<span>Request Takeover</span>';
        }
      } catch (error) {
        console.error('Error requesting takeover:', error);
        alert('Failed to send takeover request');
        requestBtn.disabled = false;
        requestBtn.innerHTML = '<span>Request Takeover</span>';
      }
    });
  }

  // Cancel takeover request
  var cancelBtn = document.getElementById('cancelTakeoverBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async function() {
      var takeoverSection = document.getElementById('takeoverSection');
      var slotId = takeoverSection && takeoverSection.dataset.slotId;
      var currentUser = deps.getCurrentUser();

      if (!slotId || !currentUser) return;

      stopTakeoverPolling();

      try {
        var response = await fetch('/api/livestream/slots/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'cancelTakeoverRequest',
            slotId: slotId,
            requesterId: currentUser.uid
          })
        });

        if (!response.ok) throw new Error('Cancel request failed');
        var result = await response.json();

        if (result.success) {
          hideTakeoverPending();
        } else {
          alert(result.error || 'Failed to cancel request');
          startTakeoverPolling(deps);
        }
      } catch (error) {
        console.error('Error cancelling takeover:', error);
        startTakeoverPolling(deps);
      }
    });
  }
}

function showTakeoverNotification(data) {
  var notification = document.getElementById('incomingTakeoverNotification');
  var nameEl = document.getElementById('incomingTakeoverName');
  var avatarEl = document.getElementById('incomingTakeoverAvatar');
  if (nameEl) nameEl.textContent = data.requesterName || 'A DJ';
  if (avatarEl) avatarEl.src = data.requesterAvatar || '/place-holder.webp';
  if (notification) {
    notification.classList.remove('hidden');
    notification.dataset.requesterId = data.requesterId;
  }
}

function hideTakeoverNotification() {
  var notification = document.getElementById('incomingTakeoverNotification');
  if (notification) notification.classList.add('hidden');
}

function showTakeoverPending() {
  var requestBtn = document.getElementById('requestTakeoverBtn');
  var pending = document.getElementById('takeoverPending');
  var approved = document.getElementById('takeoverApproved');
  if (requestBtn) requestBtn.classList.add('hidden');
  if (pending) pending.classList.remove('hidden');
  if (approved) approved.classList.add('hidden');
  startTakeoverPolling();
}

function hideTakeoverPending() {
  var requestBtn = document.getElementById('requestTakeoverBtn');
  var pending = document.getElementById('takeoverPending');
  var approved = document.getElementById('takeoverApproved');
  if (requestBtn) requestBtn.classList.remove('hidden');
  if (pending) pending.classList.add('hidden');
  if (approved) approved.classList.add('hidden');
  stopTakeoverPolling();
}

function showTakeoverApproved(streamKey) {
  var requestBtn = document.getElementById('requestTakeoverBtn');
  var pending = document.getElementById('takeoverPending');
  var approved = document.getElementById('takeoverApproved');
  var keyEl = document.getElementById('takeoverStreamKey');
  if (requestBtn) requestBtn.classList.add('hidden');
  if (pending) pending.classList.add('hidden');
  if (approved) approved.classList.remove('hidden');
  if (keyEl) keyEl.textContent = streamKey;
  stopTakeoverPolling();
}

function startTakeoverPolling(deps) {
  if (takeoverPollInterval) return;

  takeoverPollInterval = setInterval(async function() {
    var takeoverSection = document.getElementById('takeoverSection');
    var slotId = takeoverSection && takeoverSection.dataset.slotId;
    var currentUser = deps ? deps.getCurrentUser() : null;

    if (!slotId || !currentUser) {
      stopTakeoverPolling();
      return;
    }

    try {
      var response = await fetch('/api/livestream/slots/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'getStreamKey',
          slotId: slotId,
          djId: currentUser.uid
        })
      });

      if (!response.ok) return;
      var result = await response.json();

      if (result.success && result.streamKey) {
        showTakeoverApproved(result.streamKey);
      }
    } catch (error) {
      console.error('Error polling takeover status:', error);
    }
  }, 3000);
}

function stopTakeoverPolling() {
  if (takeoverPollInterval) {
    clearInterval(takeoverPollInterval);
    takeoverPollInterval = null;
  }
}

export function getTakeoverPollInterval() {
  return takeoverPollInterval;
}

export function getTakeoverFallbackInterval() {
  return takeoverFallbackInterval;
}

function updateLobbyCountdown(slot, deps) {
  var countdown = document.getElementById('lobbyCountdownBig');
  var countdownLabel = document.getElementById('lobbyCountdownLabel');
  var goLiveBtn = document.getElementById('goLiveBtn');
  var readyBtnEl = document.getElementById('readyBtn');
  var gracePeriod = document.getElementById('lobbyGracePeriod');
  var graceCountdown = document.getElementById('graceCountdown');
  var slotAvailable = document.getElementById('slotAvailableSection');

  var update = function() {
    var now = new Date();
    var start = new Date(slot.startTime);
    var secsUntilStart = Math.floor((start - now) / 1000);

    // Before start time
    if (secsUntilStart > 0) {
      if (gracePeriod) gracePeriod.classList.add('hidden');
      if (slotAvailable) slotAvailable.classList.add('hidden');

      var mins = Math.floor(secsUntilStart / 60);
      var s = secsUntilStart % 60;
      countdown.textContent = mins + ':' + s.toString().padStart(2, '0');
      if (countdownLabel) countdownLabel.textContent = 'Time until live:';

      if (isDjReady && secsUntilStart <= 120) {
        goLiveBtn.disabled = false;
      } else {
        goLiveBtn.disabled = true;
      }

      setTimeout(update, 1000);
      return;
    }

    // After start time - check grace period
    var secsLate = Math.abs(secsUntilStart);
    var graceRemaining = GRACE_PERIOD_SECONDS - secsLate;

    if (graceRemaining > 0 && !isDjReady && !slotExpired) {
      countdown.textContent = 'LATE';
      if (countdownLabel) countdownLabel.textContent = 'Your slot started!';
      if (gracePeriod) gracePeriod.classList.remove('hidden');
      if (slotAvailable) slotAvailable.classList.add('hidden');

      var gMins = Math.floor(graceRemaining / 60);
      var gSecs = graceRemaining % 60;
      if (graceCountdown) {
        graceCountdown.textContent = gMins + ':' + gSecs.toString().padStart(2, '0');
      }

      goLiveBtn.disabled = !isDjReady;

      setTimeout(update, 1000);
      return;
    }

    if (isDjReady) {
      countdown.textContent = 'NOW!';
      if (countdownLabel) countdownLabel.textContent = "You're ready!";
      if (gracePeriod) gracePeriod.classList.add('hidden');
      if (slotAvailable) slotAvailable.classList.add('hidden');
      goLiveBtn.disabled = false;
      if (readyBtnEl) readyBtnEl.classList.add('hidden');
      return;
    }

    // Grace period expired - slot is up for grabs
    if (!slotExpired) {
      slotExpired = true;
      handleSlotExpired(slot, deps);
    }

    countdown.textContent = 'EXPIRED';
    if (countdownLabel) countdownLabel.textContent = 'Slot forfeited';
    if (gracePeriod) gracePeriod.classList.add('hidden');
    goLiveBtn.disabled = true;
    if (readyBtnEl) readyBtnEl.classList.add('hidden');
  };

  update();
}

function handleSlotExpired(slot, deps) {
  notifySlotAvailable(slot.id, deps);
}

async function notifySlotAvailable(slotId, deps) {
  try {
    var currentUser = deps.getCurrentUser();
    var token = currentUser ? await currentUser.getIdToken() : null;
    await fetch('/api/livestream/manage/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'slot_expired',
        slotId: slotId,
        token: token
      })
    });
  } catch (err) {
    console.error('Failed to notify slot expiry:', err);
  }
}

function setDjReady(deps) {
  isDjReady = true;

  var readyBtnEl = document.getElementById('readyBtn');
  var readyIndicator = document.getElementById('readyIndicator');
  var readyStatusText = document.getElementById('readyStatusText');
  var goLiveBtn = document.getElementById('goLiveBtn');
  var gracePeriod = document.getElementById('lobbyGracePeriod');

  if (readyBtnEl) {
    readyBtnEl.classList.add('is-ready');
    readyBtnEl.textContent = 'Ready!';
    readyBtnEl.disabled = true;
  }

  if (readyIndicator) readyIndicator.classList.add('is-ready');
  if (readyStatusText) readyStatusText.textContent = 'Ready to go live';
  if (gracePeriod) gracePeriod.classList.add('hidden');

  // Enable go live if start time has passed or is within 2 mins
  var mySlot = deps.getMyUpcomingSlot();
  if (mySlot) {
    var now = new Date();
    var start = new Date(mySlot.startTime);
    var secsUntil = Math.floor((start - now) / 1000);
    if (secsUntil <= 120) {
      goLiveBtn.disabled = false;
    }
  }

  notifyDjReady(deps);
}

async function notifyDjReady(deps) {
  var mySlot = deps.getMyUpcomingSlot();
  var currentUser = deps.getCurrentUser();
  if (!mySlot || !currentUser) return;

  try {
    var token = await currentUser.getIdToken();
    await fetch('/api/livestream/manage/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'dj_ready',
        slotId: mySlot.id,
        token: token
      })
    });
  } catch (err) {
    console.error('Failed to notify ready status:', err);
  }
}

function resetLobbyState() {
  isDjReady = false;
  slotExpired = false;

  var readyBtnEl = document.getElementById('readyBtn');
  var readyIndicator = document.getElementById('readyIndicator');
  var readyStatusText = document.getElementById('readyStatusText');

  if (readyBtnEl) {
    readyBtnEl.classList.remove('is-ready', 'hidden');
    readyBtnEl.textContent = 'Ready';
    readyBtnEl.disabled = false;
  }
  if (readyIndicator) readyIndicator.classList.remove('is-ready');
  if (readyStatusText) readyStatusText.textContent = 'Not Ready';

  var gracePeriod = document.getElementById('lobbyGracePeriod');
  var slotAvailableSection = document.getElementById('slotAvailableSection');
  if (gracePeriod) gracePeriod.classList.add('hidden');
  if (slotAvailableSection) slotAvailableSection.classList.add('hidden');
}

async function checkForTakeoverOption(mySlot, deps) {
  var takeoverSection = document.getElementById('takeoverSection');
  if (!takeoverSection) return;

  var userInfo = deps.getUserInfo();
  if (!((userInfo && userInfo.isDj && userInfo.isApproved) || (userInfo && userInfo.isAdmin))) {
    takeoverSection.classList.add('hidden');
    return;
  }

  try {
    var response = await fetch('/api/livestream/slots/');
    if (!response.ok) return;
    var result = await response.json();
    if (!result.success) return;

    var currentUser = deps.getCurrentUser();
    var now = Date.now();
    var liveSlot = null;
    if (result.slots) {
      for (var i = 0; i < result.slots.length; i++) {
        var s = result.slots[i];
        if (s.status === 'live' && new Date(s.endTime).getTime() > now && s.djId !== (currentUser && currentUser.uid)) {
          liveSlot = s;
          break;
        }
      }
    }

    if (liveSlot) {
      takeoverSection.classList.remove('hidden');
      var nameEl = document.getElementById('takeoverDjName');
      var avatarEl = document.getElementById('takeoverDjAvatar');
      if (nameEl) nameEl.textContent = liveSlot.djName;
      if (avatarEl) avatarEl.src = liveSlot.djAvatar || '/place-holder.webp';
      takeoverSection.dataset.slotId = liveSlot.id;

      if (liveSlot.takeoverRequest && liveSlot.takeoverRequest.requesterId === (currentUser && currentUser.uid) && liveSlot.takeoverRequest.status === 'pending') {
        showTakeoverPending();
      }
    } else {
      takeoverSection.classList.add('hidden');
    }
  } catch (error) {
    console.error('Error checking for takeover option:', error);
  }
}

function copyTakeoverKey() {
  var key = document.getElementById('takeoverStreamKey');
  var keyText = key && key.textContent;
  if (keyText && keyText !== '-') {
    navigator.clipboard.writeText(keyText);
    showCopyFeedback('Stream key copied!');
  }
}

function copyLobbyStreamKey() {
  var key = document.getElementById('lobbyStreamKey');
  var keyText = key && key.textContent;
  if (keyText && keyText !== '-' && keyText !== 'Loading...') {
    navigator.clipboard.writeText(keyText);
    showCopyFeedback('Stream key copied!');
  }
}

function copyRtmpUrl() {
  navigator.clipboard.writeText('rtmp://rtmp.freshwax.co.uk/live');
  showCopyFeedback('RTMP URL copied!');
}

function showCopyFeedback(msg) {
  var statusMsg = document.getElementById('lobbyStatusMsg');
  if (statusMsg) {
    statusMsg.textContent = msg;
    statusMsg.style.background = '#10b981';
    statusMsg.style.color = '#fff';
    statusMsg.classList.remove('hidden');
    setTimeout(function() { statusMsg.classList.add('hidden'); }, 2000);
  }
}
