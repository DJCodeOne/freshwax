// public/dj-lobby/dm.js
// DJ Lobby — direct messaging between DJs

var ctx = null;

// Module-local state
var dmTargetDj = null;
var dmMessages = [];
var dmUnsubscribe = null;

export function init(context) {
  ctx = context;
}

export function getDmChannelId(uid1, uid2) {
  return [uid1, uid2].sort().join('_');
}

export function openDmModal() {
  try {
    var modal = document.getElementById('dmModal');
    var selectView = document.getElementById('dmSelectView');
    var chatView = document.getElementById('dmChatView');

    if (!modal) {
      console.error('[DM] dmModal element not found');
      return;
    }

    modal.classList.remove('hidden');
    if (selectView) selectView.classList.remove('hidden');
    if (chatView) chatView.classList.add('hidden');
    populateDmDjList();
  } catch (e) {
    console.error('[DM] Error opening modal:', e);
  }
}

export function closeDmModal() {
  document.getElementById('dmModal')?.classList.add('hidden');

  var currentUser = ctx ? ctx.getCurrentUser() : null;
  if (dmTargetDj && currentUser) {
    cleanupDmMessages();
  }

  if (dmUnsubscribe) {
    dmUnsubscribe();
    dmUnsubscribe = null;
  }

  dmTargetDj = null;
  dmMessages = [];
  var dmMessagesEl = document.getElementById('dmMessages');
  if (dmMessagesEl) {
    dmMessagesEl.innerHTML =
      '<div class="dm-welcome">' +
      '<p>Start a private conversation</p>' +
      '<p class="hint">Only you and this DJ can see these messages.</p>' +
      '</div>';
  }
}

export function populateDmDjList() {
  var list = document.getElementById('dmDjList');
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var onlineDjsCache = ctx ? ctx.getOnlineDjsCache() : [];
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var escapeHtml = ctx ? ctx.escapeHtml : function(t) { return t; };

  var otherDjs = onlineDjsCache.filter(function(dj) { return dj.odamiMa !== currentUser?.uid; });

  if (otherDjs.length === 0) {
    list.innerHTML = '<p class="empty-state">No other DJs online</p>';
    return;
  }

  list.innerHTML = otherDjs.map(function(dj) {
    var avatarLetter = dj.avatarLetter || (dj.name ? dj.name.charAt(0).toUpperCase() : 'D');
    var hasAvatar = dj.avatar && dj.avatar !== '/place-holder.webp';
    var isLive = currentStream && currentStream.djId === dj.odamiMa;

    return '<div class="dm-dj-item" data-dj-id="' + dj.odamiMa + '" data-dj-name="' + escapeHtml(dj.name || 'DJ') + '" data-dj-avatar="' + escapeHtml(dj.avatar || '') + '" data-dj-letter="' + escapeHtml(avatarLetter) + '">' +
      (hasAvatar
        ? '<img src="' + escapeHtml(dj.avatar) + '" alt="' + escapeHtml(dj.name || 'DJ') + ' avatar" width="40" height="40" loading="lazy" decoding="async" data-fallback="show-next" /><span class="dm-dj-avatar-letter" style="display:none;">' + escapeHtml(avatarLetter) + '</span>'
        : '<span class="dm-dj-avatar-letter">' + escapeHtml(avatarLetter) + '</span>'
      ) +
      '<div class="dm-dj-info">' +
      '<div class="dm-dj-name">' + escapeHtml(dj.name || 'DJ') + '</div>' +
      '<div class="dm-dj-status">' + (isLive ? '\uD83D\uDD34 Live now' : 'Online') + '</div>' +
      '</div>' +
      '</div>';
  }).join('');

  list.querySelectorAll('.dm-dj-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var djId = item.dataset.djId;
      var djName = item.dataset.djName;
      var djAvatar = item.dataset.djAvatar;
      var djLetter = item.dataset.djLetter;
      selectDmTarget(djId, djName, djAvatar, djLetter);
    });
  });
}

export function selectDmTarget(djId, djName, djAvatar, djLetter) {
  var openDmConversation = ctx ? ctx.openDmConversation : null;
  if (openDmConversation) {
    openDmConversation({ id: djId, name: djName, avatar: djAvatar, letter: djLetter });
  }

  dmTargetDj = { id: djId, name: djName, avatar: djAvatar, letter: djLetter };

  document.getElementById('dmSelectView').classList.add('hidden');
  document.getElementById('dmChatView').classList.remove('hidden');
  document.getElementById('dmChatWithName').textContent = djName;
}

export function goBackToDmList() {
  closeDmModal();

  dmTargetDj = null;

  document.getElementById('dmChatView').classList.add('hidden');
  document.getElementById('dmSelectView').classList.remove('hidden');
  populateDmDjList();
}

export function renderDmMessages() {
  var container = document.getElementById('dmMessages');
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var escapeHtml = ctx ? ctx.escapeHtml : function(t) { return t; };

  if (dmMessages.length === 0) {
    container.innerHTML =
      '<div class="dm-welcome">' +
      '<p>Start a private conversation</p>' +
      '<p class="hint">Only you and this DJ can see these messages.</p>' +
      '</div>';
    return;
  }

  container.innerHTML = dmMessages.map(function(msg) {
    var isSent = msg.senderId === currentUser?.uid;
    var time = msg.createdAt?.toDate ?
      msg.createdAt.toDate().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

    return '<div class="dm-message ' + (isSent ? 'sent' : '') + '">' +
      '<div class="dm-message-content">' +
      '<div class="dm-message-name">' + (isSent ? 'You' : escapeHtml(msg.senderName || 'DJ')) + '</div>' +
      '<div class="dm-message-text">' + escapeHtml(msg.text) + '</div>' +
      '<div class="dm-message-time">' + time + '</div>' +
      '</div>' +
      '</div>';
  }).join('');

  container.scrollTop = container.scrollHeight;
}

export async function sendDmMessage() {
  var input = document.getElementById('dmInput');
  var text = input.value.trim();
  if (!text) return;

  input.value = '';

  try {
    var sendDm = ctx ? ctx.sendDm : null;
    if (sendDm) {
      await sendDm(text);
    }
  } catch (e) {
    console.error('DM send error:', e);
    input.value = text;
  }
}

export async function cleanupDmMessages() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  if (!dmTargetDj || !currentUser) return;

  try {
    var channelId = getDmChannelId(currentUser.uid, dmTargetDj.id);
    var token = await currentUser.getIdToken();

    var dmCleanupController = new AbortController();
    var dmCleanupTimeout = setTimeout(function() { dmCleanupController.abort(); }, 15000);
    await fetch('/api/dj-lobby/dm-cleanup/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ channelId: channelId }),
      signal: dmCleanupController.signal
    });
    clearTimeout(dmCleanupTimeout);
  } catch (e) {
    console.error('DM cleanup error:', e);
  }
}

export function showDmNotification(senderId, senderName, message) {
  var notif = document.getElementById('dmNotification');
  var text = document.getElementById('dmNotifText');

  text.textContent = 'New DM from ' + senderName;
  notif.dataset.senderId = senderId;
  notif.dataset.senderName = senderName;
  notif.classList.remove('hidden');

  setTimeout(function() {
    notif.classList.add('hidden');
  }, 10000);
}

export function openDmFromNotification() {
  var notif = document.getElementById('dmNotification');
  var senderId = notif.dataset.senderId;
  var senderName = notif.dataset.senderName;
  var onlineDjsCache = ctx ? ctx.getOnlineDjsCache() : [];

  notif.classList.add('hidden');

  var senderDj = onlineDjsCache.find(function(dj) { return dj.odamiMa === senderId; });
  if (senderDj) {
    openDmModal();
    var avatarLetter = senderDj.avatarLetter || (senderDj.name ? senderDj.name.charAt(0).toUpperCase() : 'D');
    selectDmTarget(senderId, senderDj.name || senderName, senderDj.avatar || '', avatarLetter);
  } else {
    openDmModal();
  }
}

// Getters for main script to check state
export function getDmTargetDj() {
  return dmTargetDj;
}

export function setDmTargetDj(val) {
  dmTargetDj = val;
}
