// public/dj-lobby/chat.js
// DJ Lobby — livestream chat (mirrors main live page chat)

var ctx = null;

// Module-local state
var livestreamChatChannel = null;
var currentChatSendHandler = null;
var currentChatKeyHandler = null;

// Plus badge emojis
var BADGE_EMOJIS = {
  crown: '\uD83D\uDC51', fire: '\uD83D\uDD25', headphones: '\uD83C\uDFA7', skull: '\uD83D\uDC80', lion: '\uD83E\uDD81',
  leopard: '\uD83D\uDC06', palm: '\uD83C\uDF34', lightning: '\u26A1', vinyl: '\uD83D\uDCBF', speaker: '\uD83D\uDD0A',
  moon: '\uD83C\uDF19', star: '\u2B50', diamond: '\uD83D\uDC8E', snake: '\uD83D\uDC0D', bat: '\uD83E\uDD87',
  mic: '\uD83C\uDFA4', leaf: '\uD83C\uDF3F', gorilla: '\uD83E\uDD8D', spider: '\uD83D\uDD77\uFE0F', alien: '\uD83D\uDC7D'
};

export function init(context) {
  ctx = context;
}

export function getChannel() {
  return livestreamChatChannel;
}

export function setChannel(ch) {
  livestreamChatChannel = ch;
}

export async function initLivestreamChat(streamId) {
  if (!streamId) return;

  window.livestreamChatInitialized = true;

  try {
    var chatLoadController = new AbortController();
    var chatLoadTimeout = setTimeout(function() { chatLoadController.abort(); }, 15000);
    var response = await fetch('/api/livestream/chat/?streamId=' + streamId + '&limit=50', {
      signal: chatLoadController.signal
    });
    clearTimeout(chatLoadTimeout);
    if (!response.ok) {
      console.error('[LivestreamChat] Failed to load messages: HTTP ' + response.status);
      return;
    }
    var result = await response.json();

    if (result.success && result.messages) {
      renderLivestreamMessages(result.messages);
    }
  } catch (err) {
    console.error('[LivestreamChat] Failed to load messages:', err);
  }

  if (window.Pusher && window.PUSHER_CONFIG?.key) {
    if (!window.livestreamPusher) {
      window.livestreamPusher = new Pusher(window.PUSHER_CONFIG.key, {
        cluster: window.PUSHER_CONFIG.cluster || 'eu'
      });
    }

    var channelName = 'stream-' + streamId;
    livestreamChatChannel = window.livestreamPusher.subscribe(channelName);

    livestreamChatChannel.bind('new-message', function(data) {
      appendLivestreamMessage(data);
    });

    livestreamChatChannel.bind('viewer-update', function(data) {
      var viewerCount = data.count ?? data.currentViewers ?? data.totalViews ?? 0;
      if (ctx && ctx.updateCenterStats) {
        ctx.updateCenterStats({ viewers: viewerCount });
      }
      var chatViewers = document.getElementById('chatViewers');
      if (chatViewers) chatViewers.textContent = viewerCount + ' watching';
    });
  }

  setupLivestreamChatSend(streamId);

  var currentUser = ctx ? ctx.getCurrentUser() : null;
  if (currentUser) {
    document.getElementById('loginPrompt')?.classList.add('hidden');
    document.getElementById('chatForm')?.classList.remove('hidden');
  }

  var emojiBtn = document.getElementById('openEmojiPanel');
  if (emojiBtn && !emojiBtn.dataset.bound && typeof window.toggleEmojiPanel === 'undefined') {
    document.dispatchEvent(new Event('astro:page-load'));
  }
}

export function renderLivestreamMessages(messages, forceScrollToBottom) {
  if (forceScrollToBottom === undefined) forceScrollToBottom = true;
  var container = document.getElementById('chatMessages');
  if (!container) return;

  if (!messages || messages.length === 0) {
    container.innerHTML = '';
    return;
  }

  var sortedMessages = messages.slice().sort(function(a, b) {
    var dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
    var dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
    return dateA.getTime() - dateB.getTime();
  });

  var wasAtBottom = forceScrollToBottom || container.scrollTop + container.clientHeight >= container.scrollHeight - 50;

  var filteredMessages = sortedMessages.filter(function(msg) { return msg.type !== 'bot'; });
  container.innerHTML = filteredMessages.map(function(msg) { return formatLivestreamMessage(msg); }).join('');

  if (wasAtBottom) {
    var scrollToBottom = function() {
      var lastMessage = container.querySelector('.ls-chat-message:last-of-type');
      if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'instant', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    };
    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 50);
    setTimeout(scrollToBottom, 150);
  }
}

export function appendLivestreamMessage(msg) {
  var container = document.getElementById('chatMessages');
  if (!container) return;

  if (msg.type === 'bot') return;

  var wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;

  var welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  var msgHtml = formatLivestreamMessage(msg);
  container.insertAdjacentHTML('beforeend', msgHtml);

  if (wasAtBottom) {
    var scrollToBottom = function() {
      var lastMessage = container.querySelector('.ls-chat-message:last-of-type');
      if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'instant', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    };
    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  }
}

export function formatLivestreamMessage(msg) {
  var escapeHtml = ctx ? ctx.escapeHtml : function(t) { return t; };
  var time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  var rawInitial = (msg.userName || 'U').charAt(0).toUpperCase();
  var initial = /^[A-Z0-9]$/.test(rawInitial) ? rawInitial : 'U';

  var safeAvatar = msg.userAvatar && /^https?:\/\//i.test(msg.userAvatar) ? escapeHtml(msg.userAvatar) : '';
  var avatarHtml = safeAvatar
    ? '<img src="' + safeAvatar + '" alt="" class="ls-chat-avatar" width="32" height="32" loading="lazy" decoding="async" data-fallback="html" data-fallback-html="<span class=\'ls-chat-avatar-letter\'>' + initial + '</span>" />'
    : '<span class="ls-chat-avatar-letter">' + initial + '</span>';

  var badgeEmoji = msg.isPro ? (BADGE_EMOJIS[msg.badge] || BADGE_EMOJIS.crown) : '';
  var plusBadgeHtml = badgeEmoji ? '<span class="ls-chat-plus-badge">' + badgeEmoji + '</span>' : '';

  var botBadgeHtml = msg.type === 'bot' ? '<span class="ls-chat-bot-badge">BOT</span>' : '';

  var safeGiphyUrl = msg.giphyUrl && /^https?:\/\//i.test(msg.giphyUrl) ? escapeHtml(msg.giphyUrl) : '';
  if (msg.type === 'giphy' && safeGiphyUrl) {
    return '<div class="ls-chat-message" data-message-id="' + escapeHtml(msg.id || '') + '">' +
      '<div class="ls-chat-header">' +
      '<div class="ls-chat-user">' +
      avatarHtml +
      '<span class="ls-chat-username">' + escapeHtml(msg.userName || 'User') + '</span>' +
      plusBadgeHtml +
      '</div>' +
      '<span class="ls-chat-time">' + time + '</span>' +
      '</div>' +
      '<div class="ls-chat-gif">' +
      '<img src="' + safeGiphyUrl + '" alt="GIF" width="300" height="200" loading="lazy" decoding="async" />' +
      '</div>' +
      '</div>';
  }

  var botClass = msg.type === 'bot' ? 'ls-bot-message' : '';

  return '<div class="ls-chat-message ' + botClass + '" data-message-id="' + escapeHtml(msg.id || '') + '">' +
    '<div class="ls-chat-header">' +
    '<div class="ls-chat-user">' +
    avatarHtml +
    '<span class="ls-chat-username">' + escapeHtml(msg.userName || 'User') + '</span>' +
    plusBadgeHtml +
    botBadgeHtml +
    '</div>' +
    '<span class="ls-chat-time">' + time + '</span>' +
    '</div>' +
    '<div class="ls-chat-text">' + escapeHtml(msg.message || '') + '</div>' +
    '</div>';
}

export function setupLivestreamChatSend(streamId) {
  var chatInput = document.getElementById('chatInput');
  var sendBtn = document.getElementById('sendBtn');

  if (!chatInput || !sendBtn) return;

  if (currentChatSendHandler) {
    sendBtn.removeEventListener('click', currentChatSendHandler);
  }
  if (currentChatKeyHandler) {
    chatInput.removeEventListener('keypress', currentChatKeyHandler);
  }

  var sendMessage = async function() {
    var message = chatInput.value.trim();
    var currentUser = ctx ? ctx.getCurrentUser() : null;
    if (!message || !currentUser) return;

    var userInfo = ctx ? ctx.getUserInfo() : null;
    var userSubscription = ctx ? ctx.getUserSubscription() : null;
    var staleStreamIds = ctx ? ctx.getStaleStreamIds() : new Set();

    var userName = userInfo?.name || userInfo?.displayName || userInfo?.firstName || currentUser.displayName || currentUser.email?.split('@')[0] || 'User';
    var userAvatar = userInfo?.avatar || currentUser.photoURL || null;
    var isPro = userSubscription?.isPro || false;

    var tempMsg = {
      id: 'temp_' + Date.now(),
      userId: currentUser.uid,
      userName: userName,
      userAvatar: userAvatar,
      isPro: isPro,
      badge: 'crown',
      message: message,
      type: 'text',
      createdAt: new Date().toISOString()
    };
    appendLivestreamMessage(tempMsg);

    chatInput.value = '';
    chatInput.disabled = true;
    sendBtn.disabled = true;

    try {
      var token = await currentUser.getIdToken();
      var activeStreamId = window.currentStreamId || streamId;
      var chatSendController = new AbortController();
      var chatSendTimeout = setTimeout(function() { chatSendController.abort(); }, 15000);
      var response = await fetch('/api/livestream/chat/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          streamId: activeStreamId,
          userId: currentUser.uid,
          userName: userName,
          userAvatar: userAvatar,
          isPro: isPro,
          badge: 'crown',
          message: message,
          type: 'text'
        }),
        signal: chatSendController.signal
      });
      clearTimeout(chatSendTimeout);

      if (!response.ok) {
        var err = await response.json();
        console.error('[LivestreamChat] Send failed:', err);
        if (err.error === 'Stream is not live' && activeStreamId !== 'playlist-global') {
          staleStreamIds.add(activeStreamId);
          window.currentStreamId = 'playlist-global';
          cleanupLivestreamChat();
          var retryController = new AbortController();
          var retryTimeout = setTimeout(function() { retryController.abort(); }, 15000);
          var retryResponse = await fetch('/api/livestream/chat/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
              streamId: 'playlist-global',
              userId: currentUser.uid,
              userName: userName,
              userAvatar: userAvatar,
              isPro: isPro,
              badge: 'crown',
              message: message,
              type: 'text'
            }),
            signal: retryController.signal
          });
          clearTimeout(retryTimeout);
          if (!retryResponse.ok) {
            var retryErr = await retryResponse.json();
            console.error('[LivestreamChat] Retry also failed:', retryErr);
          }
        }
      }
    } catch (err) {
      console.error('[LivestreamChat] Send error:', err);
    } finally {
      chatInput.disabled = false;
      sendBtn.disabled = false;
      chatInput.focus();
    }
  };

  var keyHandler = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', keyHandler);

  currentChatSendHandler = sendMessage;
  currentChatKeyHandler = keyHandler;
}

export function cleanupLivestreamChat() {
  if (livestreamChatChannel) {
    livestreamChatChannel.unbind_all();
    window.livestreamPusher?.unsubscribe(livestreamChatChannel.name);
    livestreamChatChannel = null;
  }

  window.livestreamChatInitialized = false;
  window.currentStreamId = 'playlist-global';
  initLivestreamChat('playlist-global');
}
