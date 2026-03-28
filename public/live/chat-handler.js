// public/live/chat-handler.js
// Live page — chat rendering, sending, emoji/giphy pickers

var pusher = null;
var chatChannel = null;
var chatMessages = [];

var BADGE_EMOJIS = {
  crown: '\u{1F451}',
  fire: '\u{1F525}',
  headphones: '\u{1F3A7}',
  skull: '\u{1F480}',
  lion: '\u{1F981}',
  leopard: '\u{1F406}',
  palm: '\u{1F334}',
  lightning: '\u26A1',
  vinyl: '\u{1F4BF}',
  speaker: '\u{1F50A}',
  moon: '\u{1F319}',
  star: '\u2B50',
  diamond: '\u{1F48E}',
  snake: '\u{1F40D}',
  bat: '\u{1F987}',
  mic: '\u{1F3A4}',
  leaf: '\u{1F33F}',
  gorilla: '\u{1F98D}',
  spider: '\u{1F577}\uFE0F',
  alien: '\u{1F47D}'
};

// Internal refs
var _currentUser = null;
var _currentStream = null;
var _escapeHtml = null;
var _escapeJsString = null;
var _trackActiveUser = null;

export function initChatHandler(deps) {
  if (deps.escapeHtml) _escapeHtml = deps.escapeHtml;
  if (deps.escapeJsString) _escapeJsString = deps.escapeJsString;
  if (deps.trackActiveUser) _trackActiveUser = deps.trackActiveUser;
}

export function setChatCurrentUser(user) { _currentUser = user; }
export function setChatCurrentStream(stream) { _currentStream = stream; }
export function getChatChannel() { return chatChannel; }
export function getChatMessages() { return chatMessages; }
export function resetChatMessages() { chatMessages = []; }

async function getChatAuthHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  if (_currentUser) {
    try {
      var token = await _currentUser.getIdToken();
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (e) {}
  }
  return headers;
}

export async function setupChat(streamId) {
  if (window.location.pathname.includes('/live/fullpage')) return;

  // Ensure Pusher is loaded
  if (!window.Pusher) {
    await new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://js.pusher.com/8.2.0/pusher.min.js';
      s.onload = function() { resolve(); };
      s.onerror = function(e) {
        console.error('[DEBUG] Pusher script failed to load:', e);
        reject(e);
      };
      document.head.appendChild(s);
    });
  }

  if (!pusher) {
    // Reuse the shared statusPusher instance from pusher-events.js if available,
    // avoiding a duplicate Pusher connection for the same channels.
    if (window.statusPusher) {
      pusher = window.statusPusher;
    } else {
      var config = {
        key: (window.PUSHER_CONFIG && window.PUSHER_CONFIG.key) || '',
        cluster: (window.PUSHER_CONFIG && window.PUSHER_CONFIG.cluster) || 'eu'
      };
      if (!config.key) {
        console.error('[Chat] Pusher key not configured - check window.PUSHER_CONFIG');
        return;
      }
      pusher = new window.Pusher(config.key, { cluster: config.cluster, forceTLS: true });
      pusher.connection.bind('error', function(err) {
        console.error('[DEBUG] Pusher connection error:', err);
      });
    }
  }

  // Load initial messages
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    var resp = await fetch('/api/livestream/chat/?streamId=' + streamId + '&limit=15', {
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (resp.ok) {
      var data = await resp.json();
      if (data.success) {
        chatMessages = data.messages || [];
        chatMessages.forEach(function(msg) {
          if (_trackActiveUser) _trackActiveUser(msg);
        });
        renderChatMessages(chatMessages, true);
      }
    }
  } catch (e) {
    console.warn('[Chat] Failed to load initial messages:', e);
  }

  // Subscribe to channel
  if (chatChannel) {
    chatChannel.unbind_all();
    pusher.unsubscribe(chatChannel.name);
  }

  var channelName = 'stream-' + streamId;
  chatChannel = pusher.subscribe(channelName);

  chatChannel.bind('pusher:subscription_succeeded', function() {});
  chatChannel.bind('pusher:subscription_error', function(err) {
    console.error('[DEBUG] Channel subscription error:', channelName, err);
  });

  chatChannel.bind('new-message', function(msg) {
    chatMessages.push(msg);
    if (_trackActiveUser) _trackActiveUser(msg);
    if (chatMessages.length > 15) chatMessages = chatMessages.slice(-15);
    renderChatMessages(chatMessages);
    if (typeof window.notifyNewChatMessage === 'function') window.notifyNewChatMessage();
  });

  if (!window.location.pathname.includes('/live/fullpage')) {
    chatChannel.bind('reaction', function(data) {
      if (data.totalLikes) {
        var likeCountEl = document.getElementById('likeCount');
        if (likeCountEl) likeCountEl.textContent = data.totalLikes;
      }
      var senderId = data.sessionId || data.userId;
      var myId = window.reactionSessionId || (_currentUser && _currentUser.uid);
      if (senderId && myId && senderId === myId) return;
      var emojis = (data.emoji || '\u2764\uFE0F').split(',');
      var count = Math.min(5, 3 + Math.floor(3 * Math.random()));
      for (var i = 0; i < count; i++) {
        (function(idx) {
          setTimeout(function() {
            createFloatingEmojiFromBroadcast(emojis);
          }, 70 * idx);
        })(i);
      }
    });
  }

  chatChannel.bind('shoutout', function(data) {
    if (typeof window.handleIncomingShoutout === 'function') window.handleIncomingShoutout(data);
  });

  chatChannel.bind('like-update', function(data) {
    var likeCountEl = document.getElementById('likeCount');
    if (likeCountEl && data.totalLikes !== undefined) likeCountEl.textContent = data.totalLikes;
  });

  chatChannel.bind('viewer-update', function(data) {
    var count = data.count !== undefined ? data.count :
                data.currentViewers !== undefined ? data.currentViewers :
                data.totalViews;
    if (count !== undefined) {
      var viewerEl = document.getElementById('viewerCount');
      var fsViewersEl = document.getElementById('fsViewers');
      var chatViewersEl = document.getElementById('chatViewers');
      if (viewerEl) viewerEl.textContent = count;
      if (fsViewersEl) fsViewersEl.textContent = count;
      if (chatViewersEl) chatViewersEl.textContent = count + ' watching';
    }
  });

  window.pusherChannel = chatChannel;

  try { setupEmojiPicker(); } catch (e) { console.error('[Chat] setupEmojiPicker failed:', e); }
  try { setupGiphyPicker(); } catch (e) { console.error('[Chat] setupGiphyPicker failed:', e); }
  try { setupChatInput(streamId); } catch (e) { console.error('[Chat] setupChatInput failed:', e); }
}

function renderChatMessages(messages, isInitialLoad) {
  if (typeof isInitialLoad === 'undefined') isInitialLoad = false;
  if (window.location.pathname.includes('/live/fullpage')) return;
  var container = document.getElementById('chatMessages');
  if (!container) return;

  var sorted = messages.slice().sort(function(a, b) {
    var dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
    var dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
    return dateA.getTime() - dateB.getTime();
  });

  var shouldScroll = isInitialLoad || (container.scrollTop + container.clientHeight >= container.scrollHeight - 50);

  var html = '<div class="chat-welcome" style="text-align: center; padding: 0.75rem; background: #1a1a2e; border-radius: 8px; margin-bottom: 0.5rem;">' +
    '<p style="color: #a5b4fc; margin: 0; font-size: 0.8125rem;">Welcome! Type !help for commands \u{1F3B5}</p></div>';

  html += sorted.map(function(msg) {
    var timeStr = '';
    if (msg.createdAt) {
      var d = msg.createdAt.toDate ? msg.createdAt.toDate() : new Date(msg.createdAt);
      timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    var isBot = msg.type === 'bot' || msg.userId === 'freshwax-bot';
    var preview = msg.message ? msg.message.substring(0, 50) : '';
    var esc = _escapeHtml || function(s) { return s || ''; };
    var escJs = _escapeJsString || function(s) { return s || ''; };

    var replyHtml = '';
    if (msg.replyTo && msg.replyToUserName) {
      replyHtml = '<div style="background: #1a2e1a; border-left: 2px solid #22c55e; padding: 0.25rem 0.5rem; margin-bottom: 0.25rem; border-radius: 4px; font-size: 0.75rem;">' +
        '<span style="color: #22c55e;">\u21A9 </span>' +
        '<span style="color: #22c55e;">' + esc(msg.replyToUserName) + '</span>' +
        '<span style="color: #86efac; margin-left: 0.25rem;">' + esc((msg.replyToPreview || 'GIF').substring(0, 40)) + ((msg.replyToPreview || '').length > 40 ? '...' : '') + '</span></div>';
    }

    // System message
    if (msg.type === 'system' || msg.userId === 'system') {
      return '<div class="chat-message chat-system-message" style="padding: 0.5rem; margin: 0.5rem 0; animation: slideIn 0.2s ease-out; background: rgba(34, 197, 94, 0.1); border-radius: 8px; text-align: center; border: 1px solid rgba(34, 197, 94, 0.3);">' +
        '<div style="color: #22c55e; font-size: 0.875rem; font-weight: 500;">' + esc(msg.message) + '</div></div>';
    }

    // Bot message
    if (isBot) {
      return '<div class="chat-message chat-bot-message" style="padding: 0.5rem; margin: 0.25rem 0; animation: slideIn 0.2s ease-out; background: linear-gradient(135deg, #1a1a2e 0%, #1e293b 100%); border-radius: 8px; border-left: 3px solid #3b82f6;">' +
        '<div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">' +
        '<img src="/logo.webp" alt="Bot" width="20" height="20" style="width: 20px; height: 20px; border-radius: 50%; background: #fff; padding: 2px;" decoding="async" />' +
        '<span style="font-weight: 600; color: #3b82f6; font-size: 0.8125rem;">FreshWax</span>' +
        '<span style="background: #3b82f6; color: #fff; font-size: 0.625rem; padding: 0.125rem 0.375rem; border-radius: 4px; font-weight: 600;">BOT</span>' +
        '<span style="font-size: 0.6875rem; color: #666; margin-left: auto;">' + timeStr + '</span></div>' +
        '<div style="color: #bfdbfe; font-size: 0.875rem; word-break: break-word; line-height: 1.5; white-space: pre-line;">' + esc(msg.message) + '</div></div>';
    }

    // User message
    var badgeEmoji = msg.isPro ? (BADGE_EMOJIS[msg.badge] || BADGE_EMOJIS.crown) : '';
    var badgeHtml = badgeEmoji ? '<span style="margin-left: 4px; font-size: 14px; vertical-align: middle;">' + badgeEmoji + '</span>' : '';

    // GIF message
    if (msg.type === 'giphy' && msg.giphyUrl) {
      var gifImg = (msg.giphyUrl && /^https?:\/\//i.test(msg.giphyUrl))
        ? '<img src="' + esc(msg.giphyUrl) + '" alt="GIF" width="300" height="200" style="max-width: 300px; border-radius: 8px;" loading="lazy" decoding="async" onload="setTimeout(() => this.scrollIntoView({ behavior: \'instant\', block: \'end\' }), 50);" />'
        : '';
      return '<div class="chat-message" style="padding: 0.5rem 0; animation: slideIn 0.2s ease-out; position: relative;" onmouseenter="this.querySelector(\'.reply-btn\').style.opacity=\'1\'" onmouseleave="this.querySelector(\'.reply-btn\').style.opacity=\'0\'">' +
        replyHtml +
        '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">' +
        '<span style="font-weight: 600; color: #dc2626; font-size: 0.8125rem; display: inline-flex; align-items: center;">' + esc(msg.userName) + badgeHtml + '</span>' +
        '<div style="display: flex; align-items: center; gap: 0.5rem;">' +
        '<button class="reply-btn" onclick="window.replyToMessage(\'' + escJs(msg.id) + '\', \'' + escJs(msg.userName) + '\', \'GIF\')" style="opacity: 0; background: none; border: none; color: #22c55e; cursor: pointer; font-size: 0.75rem; transition: opacity 0.2s;">\u21A9 Reply</button>' +
        '<span style="font-size: 0.6875rem; color: #666;">' + timeStr + '</span></div></div>' +
        gifImg + '</div>';
    }

    // Regular text message
    return '<div class="chat-message" style="padding: 0.5rem 0; animation: slideIn 0.2s ease-out; position: relative;" onmouseenter="this.querySelector(\'.reply-btn\').style.opacity=\'1\'" onmouseleave="this.querySelector(\'.reply-btn\').style.opacity=\'0\'">' +
      replyHtml +
      '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.125rem;">' +
      '<span style="font-weight: 600; color: #dc2626; font-size: 0.8125rem; display: inline-flex; align-items: center;">' + esc(msg.userName) + badgeHtml + '</span>' +
      '<div style="display: flex; align-items: center; gap: 0.5rem;">' +
      '<button class="reply-btn" onclick="window.replyToMessage(\'' + escJs(msg.id) + '\', \'' + escJs(msg.userName) + '\', \'' + escJs(preview) + '\')" style="opacity: 0; background: none; border: none; color: #22c55e; cursor: pointer; font-size: 0.75rem; transition: opacity 0.2s;">\u21A9 Reply</button>' +
      '<span style="font-size: 0.6875rem; color: #666;">' + timeStr + '</span></div></div>' +
      '<div style="color: #fff; font-size: 1rem; word-break: break-word; line-height: 1.5;">' + esc(msg.message) + '</div></div>';
  }).join('');

  container.innerHTML = html;

  if (shouldScroll || isInitialLoad) {
    var scrollToEnd = function() {
      var lastMsg = container.querySelector('.chat-message:last-of-type');
      if (lastMsg) {
        lastMsg.scrollIntoView({ behavior: 'instant', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    };
    scrollToEnd();
    requestAnimationFrame(scrollToEnd);
    if (isInitialLoad) {
      setTimeout(scrollToEnd, 50);
      setTimeout(scrollToEnd, 200);
      setTimeout(scrollToEnd, 500);
    }
  }
}

function setupEmojiPicker() {
  // Placeholder — emoji picker is set up elsewhere
  return;
}

function setupGiphyPicker() {
  // Placeholder — giphy picker is set up elsewhere
  return;
}

function setupChatInput(streamId) {
  if (window.location.pathname.includes('/live/fullpage')) return;
  var chatInput = document.getElementById('chatInput');
  var sendBtn = document.getElementById('sendBtn');

  async function sendMessage() {
    if (!_currentUser || !chatInput || !chatInput.value.trim()) return;

    if (window.FreshWax && window.FreshWax.checkEmailVerified) {
      var verified = await window.FreshWax.checkEmailVerified('send chat messages');
      if (!verified) return;
    }

    var message = chatInput.value.trim();
    chatInput.value = '';

    // !skip command
    if (message.toLowerCase() === '!skip') {
      if (!window.playlistManager || !window.isPlaylistActive) return;
      try {
        var token = await _currentUser.getIdToken();
        var ctrl = new AbortController();
        var timer = setTimeout(function() { ctrl.abort(); }, 15000);
        var resp = await fetch('/api/playlist/skip/', {
          signal: ctrl.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ userId: _currentUser.uid })
        });
        clearTimeout(timer);
        if (!resp.ok) { console.error('[Chat] !skip request failed:', resp.status); return; }
        var result = await resp.json();
        if (!result.allowed) {
          var chatEl = document.getElementById('chatMessages');
          if (chatEl) {
            var errDiv = document.createElement('div');
            errDiv.className = 'chat-system-message chat-error';
            errDiv.textContent = result.reason || 'Cannot skip right now';
            chatEl.appendChild(errDiv);
            chatEl.scrollTop = chatEl.scrollHeight;
            setTimeout(function() { errDiv.remove(); }, 5000);
          }
          return;
        }
        window.playlistManager.skipTrack();
        var skipMsg = result.isAdmin
          ? '\u23ED\uFE0F Track skipped by admin'
          : '\u23ED\uFE0F Track skipped by Plus member (' + result.remaining + ' skips remaining today)';
        var skipStreamId = window.currentStreamId || 'playlist-global';
        var ctrl2 = new AbortController();
        var timer2 = setTimeout(function() { ctrl2.abort(); }, 15000);
        await fetch('/api/livestream/chat/', {
          signal: ctrl2.signal,
          method: 'POST',
          headers: await getChatAuthHeaders(),
          body: JSON.stringify({ streamId: skipStreamId, userId: 'system', userName: 'System', message: skipMsg, type: 'system' })
        });
        clearTimeout(timer2);
      } catch (e) {
        console.error('[Chat] !skip error:', e);
        var chatEl2 = document.getElementById('chatMessages');
        if (chatEl2) {
          var errDiv2 = document.createElement('div');
          errDiv2.className = 'chat-system-message chat-error';
          errDiv2.textContent = 'Failed to skip track. Please try again.';
          chatEl2.appendChild(errDiv2);
          chatEl2.scrollTop = chatEl2.scrollHeight;
          setTimeout(function() { errDiv2.remove(); }, 5000);
        }
      }
      return;
    }

    // Plus commands
    var lowerMsg = message.toLowerCase();
    var commands = ['!ping', '!vibe', '!quote', '!hype', '!shoutout', '!np', '!uptime'];
    var matchedCmd = null;
    for (var k = 0; k < commands.length; k++) {
      if (lowerMsg.startsWith(commands[k])) { matchedCmd = commands[k]; break; }
    }

    if (matchedCmd) {
      var cmdName = matchedCmd.slice(1);
      var cmdArgs = message.slice(matchedCmd.length).trim();
      try {
        var currentTrack = null;
        if (window.playlistManager && window.playlistManager.playlist) {
          var queue = window.playlistManager.playlist.queue;
          if (queue && queue.length > 0) currentTrack = { title: queue[0].title, artist: queue[0].artist };
        }
        var ctrl3 = new AbortController();
        var timer3 = setTimeout(function() { ctrl3.abort(); }, 15000);
        var cmdResp = await fetch('/api/chat/plus-command/', {
          signal: ctrl3.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: _currentUser.uid,
            userName: (window.currentUserInfo && window.currentUserInfo.name) || _currentUser.displayName || (_currentUser.email && _currentUser.email.split('@')[0]) || 'User',
            command: cmdName,
            args: cmdArgs,
            streamId: window.currentStreamId || 'playlist-global',
            streamStartTime: window.streamStartTime || null,
            currentTrack: currentTrack
          })
        });
        clearTimeout(timer3);
        if (!cmdResp.ok) { console.error('[Chat] Plus command request failed:', cmdResp.status); return; }
        var cmdResult = await cmdResp.json();
        if (!cmdResult.allowed) {
          var chatEl3 = document.getElementById('chatMessages');
          if (chatEl3) {
            var errDiv3 = document.createElement('div');
            errDiv3.className = 'chat-system-message chat-error';
            errDiv3.textContent = cmdResult.error || 'This command requires Plus membership';
            chatEl3.appendChild(errDiv3);
            chatEl3.scrollTop = chatEl3.scrollHeight;
            setTimeout(function() { errDiv3.remove(); }, 5000);
          }
          return;
        }
        var cmdStreamId = window.currentStreamId || 'playlist-global';
        var ctrl4 = new AbortController();
        var timer4 = setTimeout(function() { ctrl4.abort(); }, 15000);
        await fetch('/api/livestream/chat/', {
          signal: ctrl4.signal,
          method: 'POST',
          headers: await getChatAuthHeaders(),
          body: JSON.stringify({
            streamId: cmdStreamId,
            userId: cmdResult.type === 'system' ? 'system' : 'bot',
            userName: cmdResult.type === 'system' ? 'System' : 'FreshWax Bot',
            message: cmdResult.response,
            type: cmdResult.type || 'bot',
            isBot: true
          })
        });
        clearTimeout(timer4);
      } catch (e) {
        console.error('[Chat] Plus command error:', e);
        var chatEl4 = document.getElementById('chatMessages');
        if (chatEl4) {
          var errDiv4 = document.createElement('div');
          errDiv4.className = 'chat-system-message chat-error';
          errDiv4.textContent = 'Command failed. Please try again.';
          chatEl4.appendChild(errDiv4);
          chatEl4.scrollTop = chatEl4.scrollHeight;
          setTimeout(function() { errDiv4.remove(); }, 5000);
        }
      }
      return;
    }

    // Regular message
    var replyData = {};
    if (window.replyingTo) {
      replyData.replyTo = window.replyingTo.id;
      replyData.replyToUserName = window.replyingTo.userName;
      replyData.replyToPreview = window.replyingTo.preview;
    }
    if (window.replyingTo && window.cancelReply) window.cancelReply();

    try {
      var ctrl5 = new AbortController();
      var timer5 = setTimeout(function() { ctrl5.abort(); }, 15000);
      var body = {
        streamId: streamId,
        userId: _currentUser.uid,
        userName: (window.currentUserInfo && window.currentUserInfo.name) || _currentUser.displayName || (_currentUser.email && _currentUser.email.split('@')[0]) || 'User',
        userAvatar: (window.currentUserInfo && window.currentUserInfo.avatar) || _currentUser.photoURL || null,
        isPro: window.userIsPro === true,
        badge: window.userBadge || 'crown',
        message: message,
        type: 'text'
      };
      // Merge reply data
      if (replyData.replyTo) body.replyTo = replyData.replyTo;
      if (replyData.replyToUserName) body.replyToUserName = replyData.replyToUserName;
      if (replyData.replyToPreview) body.replyToPreview = replyData.replyToPreview;

      var resp5 = await fetch('/api/livestream/chat/', {
        signal: ctrl5.signal,
        method: 'POST',
        headers: await getChatAuthHeaders(),
        body: JSON.stringify(body)
      });
      clearTimeout(timer5);
      if (!resp5.ok) { console.error('[Chat] Send request failed:', resp5.status); return; }
      var result5 = await resp5.json();
      if (!result5.success) alert(result5.error || 'Failed to send');
    } catch (e) {
      console.error('[Chat] Send error:', e);
    }
  }

  if (chatInput) {
    chatInput.onkeypress = function(e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    };
  }
  if (sendBtn) sendBtn.onclick = sendMessage;
}

export async function sendGiphyMessage(giphyUrl, giphyId) {
  if (!_currentUser) { console.error('[GIF] No current user - not logged in'); return; }
  if (!_currentStream) { console.error('[GIF] No current stream'); return; }
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    await fetch('/api/livestream/chat/', {
      signal: ctrl.signal,
      method: 'POST',
      headers: await getChatAuthHeaders(),
      body: JSON.stringify({
        streamId: _currentStream.id,
        userId: _currentUser.uid,
        userName: (window.currentUserInfo && window.currentUserInfo.name) || _currentUser.displayName || (_currentUser.email && _currentUser.email.split('@')[0]) || 'User',
        message: '[GIF]',
        type: 'giphy',
        giphyUrl: giphyUrl,
        giphyId: giphyId
      })
    });
    clearTimeout(timer);
  } catch (e) {
    console.error('[Chat] GIF error:', e);
  }
}

export function setChatEnabled(enabled) {
  var chatInput = document.getElementById('chatInput');
  var sendBtn = document.getElementById('sendChat');
  var loginPrompt = document.getElementById('loginPrompt');
  if (chatInput) {
    chatInput.disabled = !enabled;
    chatInput.placeholder = enabled ? 'Message...' : 'Chat available when stream is live...';
  }
  if (sendBtn) sendBtn.disabled = !enabled;
  if (loginPrompt) loginPrompt.style.display = enabled ? 'none' : '';
}

function createFloatingEmojiFromBroadcast(emojis) {
  if (!window.emojiAnimationsEnabled) return;
  var path = window.location.pathname;
  if (!path.startsWith('/live') && !path.includes('/account/dj-lobby')) return;

  var container = document.querySelector('.player-column') ||
    document.querySelector('.player-wrapper') ||
    document.querySelector('.video-player:not(.hidden)') ||
    document.querySelector('.audio-player:not(.hidden)');

  var x, y;
  if (container) {
    var rect = container.getBoundingClientRect();
    x = rect.left + Math.random() * rect.width;
    y = rect.top + 0.5 * rect.height + Math.random() * rect.height * 0.3;
  } else {
    x = 0.25 * window.innerWidth + Math.random() * window.innerWidth * 0.5;
    y = 0.3 * window.innerHeight + Math.random() * window.innerHeight * 0.4;
  }

  var el = document.createElement('div');
  el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
  var drift = 60 * (Math.random() - 0.5);
  var spread = 20 + 30 * Math.random();
  var duration = 2000 + 1000 * Math.random();
  var size = 28 + Math.floor(20 * Math.random());
  var dir = Math.random() > 0.5 ? 1 : -1;

  Object.assign(el.style, {
    position: 'fixed',
    left: (x + drift) + 'px',
    top: y + 'px',
    fontSize: size + 'px',
    lineHeight: '1',
    pointerEvents: 'none',
    zIndex: '99999',
    opacity: '1',
    transform: 'scale(0)',
    margin: '0',
    padding: '0'
  });
  document.body.appendChild(el);

  var keyframes = [
    { transform: 'scale(0) rotate(0deg)', opacity: 0.8 },
    { transform: 'scale(1.3) translateY(-30px) translateX(' + (dir * spread * 0.3) + 'px) rotate(' + (15 * dir) + 'deg)', opacity: 1 },
    { transform: 'scale(1.1) translateY(-80px) translateX(' + (dir * spread * 0.6) + 'px) rotate(' + (-10 * dir) + 'deg)', opacity: 0.9 },
    { transform: 'scale(0.9) translateY(-150px) translateX(' + (dir * spread) + 'px) rotate(' + (20 * dir) + 'deg)', opacity: 0.6 },
    { transform: 'scale(0.7) translateY(-220px) translateX(' + (dir * spread * 1.2) + 'px) rotate(' + (30 * dir) + 'deg)', opacity: 0 }
  ];

  el.animate(keyframes, {
    duration: duration,
    easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    fill: 'forwards'
  }).onfinish = function() { el.remove(); };
}

export function setReactionButtonsEnabled(enabled) {
  document.querySelectorAll('.reaction-btn, .anim-toggle-btn, .fs-reaction-btn, #animToggleBtn, #fsAnimToggleBtn').forEach(function(btn) {
    if (enabled) {
      btn.classList.remove('reactions-disabled');
      btn.disabled = false;
    } else {
      btn.classList.add('reactions-disabled');
      btn.disabled = true;
    }
  });
}
