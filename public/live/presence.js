// public/live/presence.js
// Live page — Pusher presence channel, viewer tracking, heartbeat

var escapeHtml = null;
var heartbeatInterval = null;

export function initPresence(deps) {
  escapeHtml = deps.escapeHtml;
}

// Setup presence channel after Pusher loads
// NOTE: live-status events (stream-started/stream-ended) are handled by
// pusher-events.js via live-stream.js — no duplicate subscription here.
// Reaction/like/viewer events on stream-{id} are handled by chat-handler.js.
export async function setupLiveStatusListener(deps) {
  var config = window.PUSHER_CONFIG;
  if (!config || !config.key) {
    return;
  }

  try {
    // Subscribe to presence channel for viewer tracking
    var streamId = window.currentStreamId || 'playlist-global';
    var presenceChannelName = 'presence-stream-' + streamId;

    // Get user info for presence data
    var cachedAuth = null;
    try {
      var cached = sessionStorage.getItem('fw_auth_cache');
      if (cached) {
        cachedAuth = JSON.parse(cached);
        if (cachedAuth.cachedAt && Date.now() - cachedAuth.cachedAt > 3600000) {
          cachedAuth = null;
        }
      }
    } catch (e) { /* ignore */ }

    var currentUser = deps.getCurrentUser();
    var userInfo = deps.getUserInfo();
    var userId = (currentUser && currentUser.uid) || (cachedAuth && cachedAuth.id) || getOrCreateSessionId();
    var userName = (userInfo && userInfo.name) || (cachedAuth && cachedAuth.name) || (currentUser && currentUser.displayName) || 'Viewer';
    var userAvatar = (userInfo && userInfo.avatar) || (cachedAuth && cachedAuth.avatarUrl) || (currentUser && currentUser.photoURL) || '';

    // Create Pusher instance with presence auth
    var presencePusher = new window.Pusher(config.key, {
      cluster: config.cluster || 'eu',
      forceTLS: true,
      authEndpoint: '/api/pusher/auth/',
      auth: {
        headers: {
          'x-user-id': userId,
          'x-user-name': userName,
          'x-user-avatar': userAvatar
        }
      }
    });

    window.presencePusher = presencePusher;

    var presenceChannel = presencePusher.subscribe(presenceChannelName);
    window.presenceChannel = presenceChannel;

    function updateOnlineUsers() {
      var channel = window.presenceChannel;
      var count = (channel && channel.members && channel.members.count) || 0;
      var viewerEl = document.getElementById('viewerCount');
      var fsViewers = document.getElementById('fsViewers');
      var chatViewers = document.getElementById('chatViewers');
      if (viewerEl) viewerEl.textContent = count;
      if (fsViewers) fsViewers.textContent = count;
      if (chatViewers) chatViewers.textContent = count + ' watching';

      var mobileCount = document.getElementById('onlineUserCountMobile');
      if (mobileCount) mobileCount.textContent = count;

      var usersHtml = '';
      if (channel && channel.members) {
        if (count === 0) {
          usersHtml = '<p class="no-users-msg">No users online</p>';
        } else {
          channel.members.each(function(member) {
            var avatar = member.info ? member.info.avatar : null;
            var name = (member.info ? member.info.name : null) || 'Viewer';
            var avatarHtml = avatar
              ? '<div class="online-user-avatar"><img src="' + escapeHtml(avatar) + '" alt="' + escapeHtml(name) + '" width="32" height="32" loading="lazy" decoding="async" /></div>'
              : '<div class="online-user-avatar">' + escapeHtml(name.charAt(0).toUpperCase()) + '</div>';
            usersHtml += '<div class="online-user-item" data-user-id="' + escapeHtml(member.id) + '">' + avatarHtml + '<span class="online-user-name">' + escapeHtml(name) + '</span></div>';
          });
        }
      }

      var mobileScroll = document.getElementById('onlineUsersMobileScroll');
      if (mobileScroll) mobileScroll.innerHTML = usersHtml || '<p class="no-users-msg">No users online</p>';
    }

    window.updateOnlineUsers = updateOnlineUsers;

    presencePusher.connection.bind('state_change', function(states) {
    });

    presencePusher.connection.bind('error', function(err) {
      console.error('[Presence] Connection error:', err);
    });

    presenceChannel.bind('pusher:subscription_succeeded', function(members) {
      updateOnlineUsers();
    });

    presenceChannel.bind('pusher:subscription_error', function(error) {
      console.error('[Presence] Subscription error:', error);
      console.error('[Presence] Error details:', JSON.stringify(error));
    });

    presenceChannel.bind('pusher:member_added', function(member) {
      updateOnlineUsers();
    });

    presenceChannel.bind('pusher:member_removed', function(member) {
      updateOnlineUsers();
    });

    // NOTE: reaction/like/viewer events on stream-{id} are handled by
    // chat-handler.js — no duplicate subscription here.

  } catch (err) {
    console.warn('[Presence] Failed to setup Pusher:', err);
  }
}

export async function waitForPusherAndSetup(deps) {
  var maxWait = 10000;
  var startTime = Date.now();

  while (!window.Pusher && Date.now() - startTime < maxWait) {
    await new Promise(function(resolve) { setTimeout(resolve, 100); });
  }

  if (window.Pusher) {
    setupLiveStatusListener(deps);
  } else {
    console.warn('[LiveStatus] Pusher not available after waiting');
  }
}

// Session ID for anonymous viewer tracking
export function getOrCreateSessionId() {
  var sessionId = sessionStorage.getItem('viewerSessionId');
  if (!sessionId) {
    sessionId = 'anon_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    sessionStorage.setItem('viewerSessionId', sessionId);
  }
  return sessionId;
}

// Register view and trigger viewer count broadcast
export async function registerStreamView(deps) {
  var streamId = window.currentStreamId || (document.body.dataset && document.body.dataset.streamId) || 'playlist-global';
  if (!streamId) return;

  var currentUser = deps.getCurrentUser();
  var userInfo = deps.getUserInfo();

  try {
    var resp = await fetch('/api/livestream/listeners/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        streamId: streamId,
        userId: (currentUser && currentUser.uid) || getOrCreateSessionId(),
        userName: (userInfo && userInfo.name) || 'Viewer'
      })
    });
    if (!resp.ok) return;
    var data = await resp.json();
    if (data.activeViewers !== undefined) {
      var viewerEl = document.getElementById('viewerCount');
      var fsViewers = document.getElementById('fsViewers');
      var chatViewers = document.getElementById('chatViewers');
      if (viewerEl) viewerEl.textContent = data.activeViewers;
      if (fsViewers) fsViewers.textContent = data.activeViewers;
      if (chatViewers) chatViewers.textContent = data.activeViewers + ' watching';
    }
  } catch (e) {
    console.warn('[Viewers] Registration failed:', e);
  }
}

export function startListenerHeartbeat(deps) {
  if (!window.currentStreamId) {
    window.currentStreamId = 'playlist-global';
  }

  registerStreamView(deps);

  heartbeatInterval = setInterval(async function() {
    var streamId = window.currentStreamId || 'playlist-global';
    var currentUser = deps.getCurrentUser();
    var userInfo = deps.getUserInfo();
    try {
      await fetch('/api/livestream/listeners/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'heartbeat',
          streamId: streamId,
          userId: (currentUser && currentUser.uid) || getOrCreateSessionId(),
          userName: (userInfo && userInfo.name) || 'Viewer'
        })
      });
    } catch (e) { /* silent */ }
  }, 60000);
}

export function stopListenerHeartbeat(deps) {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  var streamId = window.currentStreamId || 'playlist-global';
  var currentUser = deps.getCurrentUser();
  navigator.sendBeacon('/api/livestream/listeners/', JSON.stringify({
    action: 'leave',
    streamId: streamId,
    userId: (currentUser && currentUser.uid) || getOrCreateSessionId()
  }));
}

export function getHeartbeatInterval() {
  return heartbeatInterval;
}

// Re-subscribe to presence channel with correct user info
export function resubscribePresence(deps) {
  if (!window.presencePusher || !window.presenceChannel) return;

  var currentUser = deps.getCurrentUser();
  var userInfo = deps.getUserInfo();
  if (!currentUser) return;

  var streamId = window.currentStreamId || 'playlist-global';
  var channelName = 'presence-stream-' + streamId;

  window.presencePusher.unsubscribe(channelName);

  var displayName = (userInfo && userInfo.name) || currentUser.displayName || 'User';
  var avatarUrl = (userInfo && userInfo.avatar) || currentUser.photoURL || '';

  var resubHeaders = {
    'x-user-id': currentUser.uid,
    'x-user-name': displayName,
    'x-user-avatar': avatarUrl
  };

  // Add auth token if available
  currentUser.getIdToken().then(function(token) {
    if (token) resubHeaders['Authorization'] = 'Bearer ' + token;
    window.presencePusher.config.auth = { headers: resubHeaders };

    var newChannel = window.presencePusher.subscribe(channelName);
    window.presenceChannel = newChannel;

    newChannel.bind('pusher:subscription_succeeded', function() {
      if (typeof window.updateOnlineUsers === 'function') {
        window.updateOnlineUsers();
      }
    });
    newChannel.bind('pusher:member_added', function() {
      if (typeof window.updateOnlineUsers === 'function') {
        window.updateOnlineUsers();
      }
    });
    newChannel.bind('pusher:member_removed', function() {
      if (typeof window.updateOnlineUsers === 'function') {
        window.updateOnlineUsers();
      }
    });
  }).catch(function() {
    window.presencePusher.config.auth = { headers: resubHeaders };
    var newChannel = window.presencePusher.subscribe(channelName);
    window.presenceChannel = newChannel;
  });
}
