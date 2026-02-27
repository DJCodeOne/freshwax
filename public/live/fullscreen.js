// public/live/fullscreen.js
// Live page — fullscreen mode module

var fullscreenStatsInterval = null;
var fsTwitchChannel = null;

export function initFullscreen() {
  // Exit fullscreen
  var exitBtn = document.getElementById('exitFullscreen');
  if (exitBtn) exitBtn.addEventListener('click', closeFullscreen);

  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeFullscreen(); });

  // Fullscreen chat send
  var fsSendBtn = document.getElementById('fsSendBtn');
  if (fsSendBtn) {
    fsSendBtn.addEventListener('click', function() {
      var input = document.getElementById('fsChatInput');
      var mainInput = document.getElementById('chatInput');
      var mainSend = document.getElementById('sendBtn');
      if (input && input.value.trim() && mainInput && mainSend) {
        mainInput.value = input.value;
        mainSend.click();
        input.value = '';
      }
    });
  }

  // Enter key for fullscreen chat
  var fsChatInput = document.getElementById('fsChatInput');
  if (fsChatInput) {
    fsChatInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        var sendBtn = document.getElementById('fsSendBtn');
        if (sendBtn) sendBtn.click();
      }
    });
  }

  // Fullscreen shoutout button - open main shoutout modal
  var fsShoutoutBtn = document.getElementById('fsShoutoutBtn');
  if (fsShoutoutBtn) {
    fsShoutoutBtn.addEventListener('click', function() {
      var shoutoutBtn = document.getElementById('shoutoutBtn');
      if (shoutoutBtn) shoutoutBtn.click();
    });
  }

  // Fullscreen volume slider
  setupVolumeSync();

  // Chat tab click handlers
  document.querySelectorAll('.fs-chat-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var chatType = tab.dataset.chat;
      if (chatType) {
        switchFsChat(chatType);
      }
    });
  });

  // Expose globally for live-stream.js to call
  window.setupFsTwitchChat = setupFsTwitchChat;
}

export function openFullscreen() {
  var fs = document.getElementById('fullscreenMode');
  if (fs) {
    fs.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    syncFullscreenState();
    startFullscreenStats();
    // Sync volume slider
    var fsVol = document.getElementById('fsVolumeSlider');
    var mainVol = document.getElementById('volumeSlider');
    if (fsVol && mainVol) fsVol.value = mainVol.value;
  }
}

export function closeFullscreen() {
  var fs = document.getElementById('fullscreenMode');
  if (fs) {
    fs.classList.add('hidden');
    document.body.style.overflow = '';
  }
  stopFullscreenStats();
}

export function syncFullscreenState() {
  var mainBadge = document.getElementById('liveBadge');
  var fsBadge = document.getElementById('fsLiveBadge');
  var fsStatus = document.getElementById('fsLiveStatus');
  var fsTitle = document.getElementById('fsStreamTitle');
  var fsAvatar = document.getElementById('fsDjAvatar');
  var fsName = document.getElementById('fsDjName');
  var fsOffline = document.getElementById('fsOfflineOverlay');
  var fsAudioPlaceholder = document.getElementById('fsAudioPlaceholder');
  var fsVideo = document.getElementById('fsVideo');

  // Clear loading state when syncing
  if (fsBadge) fsBadge.classList.remove('is-loading');

  // Check if we're in audio-only mode (audioPlayer is visible)
  var audioPlayer = document.getElementById('audioPlayer');
  var isAudioMode = audioPlayer && !audioPlayer.classList.contains('hidden');

  if (mainBadge && mainBadge.classList.contains('is-live')) {
    if (fsBadge) fsBadge.classList.add('is-live');
    if (fsStatus) fsStatus.textContent = 'LIVE';
    if (fsOffline) fsOffline.classList.add('hidden');

    // Show/hide audio placeholder based on mode
    if (isAudioMode) {
      if (fsAudioPlaceholder) fsAudioPlaceholder.classList.remove('hidden');
      if (fsVideo) fsVideo.classList.add('hidden');

      // Sync DJ info to fullscreen audio placeholder
      var mainDjName = document.getElementById('audioDjName');
      var mainDjAvatar = document.getElementById('vinylDjAvatar');
      var mainAudioBadge = document.getElementById('audioBadgeText');
      var fsAudioDjName = document.getElementById('fsAudioDjName');
      var fsVinylAvatar = document.getElementById('fsVinylDjAvatar');
      var fsVinylAvatar2 = document.getElementById('fsVinylDjAvatar2');
      var fsAudioBadge = document.getElementById('fsAudioBadgeText');

      if (fsAudioDjName && mainDjName) fsAudioDjName.innerHTML = mainDjName.innerHTML;
      if (fsVinylAvatar && mainDjAvatar) fsVinylAvatar.src = mainDjAvatar.src;
      if (fsVinylAvatar2 && mainDjAvatar) fsVinylAvatar2.src = mainDjAvatar.src;
      if (fsAudioBadge && mainAudioBadge) fsAudioBadge.textContent = mainAudioBadge.textContent;
    } else {
      if (fsAudioPlaceholder) fsAudioPlaceholder.classList.add('hidden');
      if (fsVideo) fsVideo.classList.remove('hidden');
    }
  } else {
    if (fsBadge) fsBadge.classList.remove('is-live');
    if (fsStatus) fsStatus.textContent = 'OFFLINE';
    if (fsOffline) fsOffline.classList.remove('hidden');
    if (fsAudioPlaceholder) fsAudioPlaceholder.classList.add('hidden');
  }

  var mainTitle = document.getElementById('streamTitle');
  var mainAvatar = document.getElementById('djAvatar');
  var mainName = document.getElementById('controlsDjName');

  if (fsTitle && mainTitle) fsTitle.textContent = mainTitle.textContent;
  if (fsAvatar && mainAvatar) fsAvatar.src = mainAvatar.src;
  if (fsName && mainName) fsName.innerHTML = mainName.innerHTML;
}

function startFullscreenStats() {
  if (fullscreenStatsInterval) return;
  fullscreenStatsInterval = setInterval(function() {
    var fsViewers = document.getElementById('fsViewers');
    var fsLikes = document.getElementById('fsLikes');
    var fsDuration = document.getElementById('fsDuration');
    var mainViewers = document.getElementById('viewerCount');
    var mainLikes = document.getElementById('likeCount');
    var mainDuration = document.getElementById('streamDuration');

    if (fsViewers && mainViewers) fsViewers.textContent = mainViewers.textContent;
    if (fsLikes && mainLikes) fsLikes.textContent = mainLikes.textContent;
    if (fsDuration && mainDuration) fsDuration.textContent = mainDuration.textContent;

    var mainChat = document.getElementById('chatMessages');
    var fsChat = document.getElementById('fsChatMessages');
    if (mainChat && fsChat) {
      fsChat.innerHTML = mainChat.innerHTML;
      fsChat.scrollTop = fsChat.scrollHeight;
    }
  }, 1000);
}

export function stopFullscreenStats() {
  if (fullscreenStatsInterval) {
    clearInterval(fullscreenStatsInterval);
    fullscreenStatsInterval = null;
  }
}

export function getFullscreenStatsInterval() {
  return fullscreenStatsInterval;
}

function setupVolumeSync() {
  var fsVolumeSlider = document.getElementById('fsVolumeSlider');
  var mainVolumeSlider = document.getElementById('volumeSlider');

  if (fsVolumeSlider) {
    fsVolumeSlider.addEventListener('input', function(e) {
      var value = e.target.value;
      if (mainVolumeSlider) {
        mainVolumeSlider.value = value;
        mainVolumeSlider.dispatchEvent(new Event('input'));
      }
    });
  }

  // Also sync main to fullscreen
  if (mainVolumeSlider) {
    mainVolumeSlider.addEventListener('input', function() {
      if (fsVolumeSlider) {
        fsVolumeSlider.value = mainVolumeSlider.value;
      }
    });
  }
}

function setupFsTwitchChat(twitchChannel) {
  var twitchTab = document.getElementById('fsTwitchChatTab');
  var twitchFrame = document.getElementById('fsTwitchChatFrame');
  var twitchPlaceholder = document.getElementById('fsTwitchPlaceholder');

  if (twitchChannel && twitchChannel.trim()) {
    // Show Twitch tab
    if (twitchTab) twitchTab.classList.remove('hidden');
    fsTwitchChannel = twitchChannel.trim().toLowerCase();

    // Set up iframe URL with parent domain
    var host = window.location.hostname;
    var twitchChatUrl = 'https://www.twitch.tv/embed/' + fsTwitchChannel + '/chat?parent=' + host + '&darkpopout';

    if (twitchFrame) {
      twitchFrame.src = twitchChatUrl;
      if (twitchPlaceholder) twitchPlaceholder.classList.add('hidden');
    }
  } else {
    // Hide Twitch tab if no channel
    if (twitchTab) twitchTab.classList.add('hidden');
    fsTwitchChannel = null;

    // Switch to Fresh Wax chat if currently on Twitch
    var activeTwitchTab = document.querySelector('.fs-chat-tab[data-chat="twitch"].active');
    if (activeTwitchTab) {
      switchFsChat('freshwax');
    }
  }
}

function switchFsChat(chatType) {
  var tabs = document.querySelectorAll('.fs-chat-tab');
  var containers = document.querySelectorAll('.fs-chat-container');

  tabs.forEach(function(tab) {
    if (tab.dataset.chat === chatType) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  containers.forEach(function(container) {
    if (container.id === 'fs' + chatType.charAt(0).toUpperCase() + chatType.slice(1) + 'ChatContainer') {
      container.classList.add('active');
    } else {
      container.classList.remove('active');
    }
  });
}
