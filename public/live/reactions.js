// public/live/reactions.js
// Live page — emoji reactions module

var escapeHtml = null;

// Use window.emojiAnimationsEnabled so live-stream.js and reactions share the same state
if (typeof window.emojiAnimationsEnabled === 'undefined') {
  window.emojiAnimationsEnabled = true;
}

// Respect prefers-reduced-motion
var reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
var prefersReducedMotion = reducedMotionQuery.matches;
reducedMotionQuery.addEventListener('change', function(e) { prefersReducedMotion = e.matches; });

// Track reaction state to prevent spam
var lastReactionTime = 0;
// Unique session ID for this browser tab
var reactionSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
window.reactionSessionId = reactionSessionId;
var REACTION_COOLDOWN = 500; // 500ms between reactions

export function initReactions(deps) {
  escapeHtml = deps.escapeHtml;
  setupReactionButtons();
  setupAnimationToggle();
  setupFullscreenReactionButtons();
}

function createFloatingEmoji(startX, startY, emojiList) {
  // Only show emojis on live pages (ViewTransitions keeps scripts alive across pages)
  var path = window.location.pathname;
  if (!path.startsWith('/live') && !path.includes('/account/dj-lobby')) {
    return;
  }

  // Check if animations are enabled (shared via window with live-stream.js)
  if (!window.emojiAnimationsEnabled) return;

  var heart = document.createElement('div');

  // Pick random emoji from the list
  var emojis = emojiList || ['\u2764\uFE0F', '\uD83D\uDC96', '\uD83D\uDC97', '\uD83D\uDC93', '\uD83D\uDC95'];
  heart.textContent = emojis[Math.floor(Math.random() * emojis.length)];

  // Reduced motion: show emoji briefly in place, then fade out (no floating/wiggling)
  if (prefersReducedMotion) {
    var fontSize = 28 + Math.floor(Math.random() * 20);
    Object.assign(heart.style, {
      position: 'fixed',
      left: startX + 'px',
      top: startY + 'px',
      fontSize: fontSize + 'px',
      lineHeight: '1',
      pointerEvents: 'none',
      zIndex: '99999',
      opacity: '1',
      transform: 'translateX(-50%)',
      transition: 'opacity 0.5s ease-out',
      margin: '0',
      padding: '0'
    });
    document.body.appendChild(heart);
    setTimeout(function() { heart.style.opacity = '0'; }, 400);
    setTimeout(function() { heart.remove(); }, 900);
    return;
  }

  // Random spread and wiggle parameters
  var spreadX = (Math.random() - 0.5) * 60;
  var wiggleAmount = 20 + Math.random() * 30;
  var duration = 2000 + Math.random() * 1000;
  var fontSz = 28 + Math.floor(Math.random() * 20);

  // Calculate position
  var posX = startX + spreadX;
  var posY = startY;

  // Apply all styles inline
  Object.assign(heart.style, {
    position: 'fixed',
    left: posX + 'px',
    top: posY + 'px',
    fontSize: fontSz + 'px',
    lineHeight: '1',
    pointerEvents: 'none',
    zIndex: '99999',
    opacity: '1',
    transform: 'translateX(-50%) scale(0)',
    margin: '0',
    padding: '0'
  });

  document.body.appendChild(heart);

  // Animate using requestAnimationFrame
  var startTime = performance.now();

  function animate(time) {
    var elapsed = time - startTime;
    var progress = Math.min(elapsed / duration, 1);

    // Easing function
    var easeOut = 1 - Math.pow(1 - progress, 3);

    // Calculate animation values
    var moveY = easeOut * 350;
    var wiggle = Math.sin(progress * Math.PI * 4) * wiggleAmount * (1 - progress);

    // Scale animation
    var scale = 1;
    if (progress < 0.1) {
      scale = progress * 12;
    } else if (progress < 0.2) {
      scale = 1.2 - (progress - 0.1) * 2;
    } else {
      scale = 1 - (progress - 0.2) * 0.3;
    }

    // Opacity
    var opacity = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1;

    // Update position
    heart.style.left = (posX + wiggle) + 'px';
    heart.style.top = (posY - moveY) + 'px';
    heart.style.opacity = String(opacity);
    heart.style.transform = 'translateX(-50%) scale(' + scale + ')';

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      heart.remove();
    }
  }

  requestAnimationFrame(animate);
}

export function triggerReactionBurst(element, emojiList) {
  // Only show emojis on live pages (ViewTransitions keeps scripts alive across pages)
  var path = window.location.pathname;
  if (!path.startsWith('/live') && !path.includes('/account/dj-lobby')) {
    return;
  }

  // Get position from element or default to video player area
  var x = window.innerWidth / 2;
  var y = window.innerHeight / 2;

  if (element && element.getBoundingClientRect) {
    var rect = element.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  } else {
    // Position over the video player when no element provided (incoming reactions from other users)
    var playerContainer = document.getElementById('playerContainer');
    if (playerContainer) {
      var pRect = playerContainer.getBoundingClientRect();
      x = pRect.left + pRect.width / 2;
      y = pRect.top + pRect.height * 0.7;
    }
  }

  // Create burst of emojis
  var numHearts = 1;
  for (var i = 0; i < numHearts; i++) {
    (function(idx) {
      setTimeout(function() {
        createFloatingEmoji(x, y, emojiList);
      }, idx * 70);
    })(i);
  }
}

// Legacy function - alias for hearts
function triggerHeartBurst(element) {
  var el = element;
  var elist = (el && el.dataset && el.dataset.emoji) ? el.dataset.emoji.split(',') : ['\u2764\uFE0F', '\uD83D\uDC96', '\uD83D\uDC97', '\uD83D\uDC93', '\uD83D\uDC95'];
  triggerReactionBurst(el, elist);
}

// Expose globally
window.triggerHeartBurst = triggerHeartBurst;
window.triggerReactionBurst = triggerReactionBurst;

// Legacy function for compatibility
function createHeart(x, y) {
  createFloatingEmoji(x || 100, y || 100, ['\u2764\uFE0F', '\uD83D\uDC96', '\uD83D\uDC97']);
}

async function triggerReaction(e) {
  e.preventDefault();
  // Require login for all reactions
  var auth = window.firebaseAuth;
  var user = auth && auth.currentUser;

  if (!user) {
    if (window.showToast) {
      window.showToast('Please log in to react to the stream');
    } else {
      alert('Please log in to react to the stream');
    }
    return;
  }

  // Cooldown to prevent spam
  var now = Date.now();
  if (now - lastReactionTime < REACTION_COOLDOWN) {
    return;
  }
  lastReactionTime = now;

  var btn = e.currentTarget || e.target;
  var emojiList = (btn && btn.dataset && btn.dataset.emoji) ? btn.dataset.emoji.split(',') : ['\u2764\uFE0F'];
  var emojiType = (btn && btn.id) ? btn.id.replace('Btn', '') : 'like';
  // Trigger visual animation locally
  triggerReactionBurst(btn, emojiList);
  if (btn) btn.classList.add('liked');
  setTimeout(function() { if (btn) btn.classList.remove('liked'); }, 300);

  // Optimistic UI - increment count immediately
  var likeCountEl = document.getElementById('likeCount');
  var currentCount = parseInt((likeCountEl && likeCountEl.textContent) || '0');
  if (likeCountEl) likeCountEl.textContent = currentCount + 1;

  // Check if we're in playlist mode or livestream mode
  var isPlaylistMode = window.isPlaylistActive;
  var streamId = window.currentStreamId || (document.body.dataset && document.body.dataset.streamId);

  try {
    if (isPlaylistMode) {
      // Playlist mode - use livestream react API with playlist-global streamId
      var token = null;
      try { token = await window.firebaseAuth.currentUser.getIdToken(); } catch (e2) { /* ignore */ }
      var emojiResponse = await fetch('/api/livestream/react/', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {}),
        body: JSON.stringify({
          action: 'emoji',
          streamId: 'playlist-global',
          userId: user.uid,
          userName: (window.currentUserInfo && window.currentUserInfo.name) || user.displayName || (user.email && user.email.split('@')[0]) || 'Viewer',
          emoji: emojiList.join(','),
          emojiType: emojiType,
          sessionId: reactionSessionId
        })
      });
      if (!emojiResponse.ok) return;
      var emojiResult = await emojiResponse.json();
      // Also update the global reaction count
      var countResponse = await fetch('/api/playlist/global/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'react' })
      });
      if (!countResponse.ok) return;
      var countResult = await countResponse.json();
      if (countResult.success && countResult.playlist && countResult.playlist.reactionCount !== undefined && likeCountEl) {
        likeCountEl.textContent = countResult.playlist.reactionCount;
      }
    } else if (streamId) {
      // Livestream mode - use livestream react API
      var lsToken = null;
      try { lsToken = await window.firebaseAuth.currentUser.getIdToken(); } catch (e3) { /* ignore */ }
      var lsResponse = await fetch('/api/livestream/react/', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, lsToken ? { 'Authorization': 'Bearer ' + lsToken } : {}),
        body: JSON.stringify({
          action: 'emoji',
          streamId: streamId,
          userId: user.uid,
          userName: (window.currentUserInfo && window.currentUserInfo.name) || user.displayName || (user.email && user.email.split('@')[0]) || 'Viewer',
          emoji: emojiList.join(','),
          emojiType: emojiType,
          sessionId: reactionSessionId
        })
      });
      if (!lsResponse.ok) return;
      var lsResult = await lsResponse.json();
      // Update with actual count from server if available (only if > 0)
      if (lsResult.success && lsResult.totalLikes > 0 && likeCountEl) {
        likeCountEl.textContent = lsResult.totalLikes;
      }
    } else {
      if (likeCountEl) likeCountEl.textContent = currentCount;
    }
  } catch (error) {
    console.error('[Reaction] API error:', error);
    // Revert optimistic update on error
    if (likeCountEl) likeCountEl.textContent = currentCount;
  }
}

function setupReactionButtons() {
  setTimeout(function() {
    ['likeBtn', 'fireBtn', 'explosionBtn', 'starBtn', 'bassBtn', 'fistBtn', 'clapBtn', 'rocketBtn'].forEach(function(id) {
      var btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('click', function(e) {
          triggerReaction(e);
        });
      }
    });

    // Like button in stats bar
    var likeStatBtn = document.getElementById('likeStatBtn');
    if (likeStatBtn) {
      likeStatBtn.addEventListener('click', async function(e) {
        e.preventDefault();
        e.stopPropagation();

        var auth = window.firebaseAuth;
        var user = auth && auth.currentUser;

        if (!user) {
          if (window.showToast) {
            window.showToast('Please log in to like the stream');
          } else {
            alert('Please log in to like the stream');
          }
          return;
        }

        var sid = window.currentStreamId;
        if (!sid) {
          return;
        }

        // Immediate visual feedback - optimistic UI
        var likeCountEl = document.getElementById('likeCount');
        var currentCount = parseInt((likeCountEl && likeCountEl.textContent) || '0');
        if (likeCountEl) likeCountEl.textContent = currentCount + 1;

        // Animation feedback
        likeStatBtn.classList.add('clicking');
        likeStatBtn.classList.add('liked');
        setTimeout(function() { likeStatBtn.classList.remove('clicking'); }, 300);

        // Trigger heart animation from button position
        triggerReactionBurst(likeStatBtn, ['\u2764\uFE0F', '\uD83D\uDC96', '\uD83D\uDC97', '\uD83D\uDC93', '\uD83D\uDC95']);

        try {
          // Send like and broadcast emoji to all viewers
          var likeToken = null;
          try { likeToken = await window.firebaseAuth.currentUser.getIdToken(); } catch (e2) { /* ignore */ }
          fetch('/api/livestream/react/', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, likeToken ? { 'Authorization': 'Bearer ' + likeToken } : {}),
            body: JSON.stringify({
              action: 'emoji',
              streamId: sid,
              userId: user.uid,
              userName: (window.currentUserInfo && window.currentUserInfo.name) || user.displayName || 'Viewer',
              emoji: '\u2764\uFE0F,\uD83D\uDC96,\uD83D\uDC97,\uD83D\uDC93,\uD83D\uDC95',
              emojiType: 'like'
            })
          }).catch(function() { /* non-critical: fire-and-forget Pusher reaction event */ });

          // Increment like count in database
          var response = await fetch('/api/livestream/react/', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, likeToken ? { 'Authorization': 'Bearer ' + likeToken } : {}),
            body: JSON.stringify({
              action: 'like',
              streamId: sid,
              userId: user.uid
            })
          });

          if (!response.ok) throw new Error('Like request failed');
          var result = await response.json();
          // Update with actual count from server (only if > 0)
          if (result.success && result.totalLikes > 0 && likeCountEl) {
            likeCountEl.textContent = result.totalLikes;
          }
        } catch (error) {
          console.error('[Like] Error:', error);
          // Revert optimistic update on error
          if (likeCountEl) likeCountEl.textContent = currentCount;
        }
      });
    }
  }, 100);
}

function setupAnimationToggle() {
  var animToggleBtn = document.getElementById('animToggleBtn');
  var fsAnimToggleBtn = document.getElementById('fsAnimToggleBtn');

  function toggleEmojiAnimations() {
    var auth = window.firebaseAuth;
    var user = auth && auth.currentUser;
    if (!user) {
      if (window.showToast) {
        window.showToast('Please log in to toggle emoji animations');
      } else {
        alert('Please log in to toggle emoji animations');
      }
      return;
    }

    window.emojiAnimationsEnabled = !window.emojiAnimationsEnabled;
    var isOff = !window.emojiAnimationsEnabled;
    var title = window.emojiAnimationsEnabled ? 'Turn off emoji animations' : 'Turn on emoji animations';

    // Sync both buttons
    if (animToggleBtn) animToggleBtn.classList.toggle('off', isOff);
    if (fsAnimToggleBtn) fsAnimToggleBtn.classList.toggle('off', isOff);
    if (animToggleBtn) animToggleBtn.title = title;
    if (fsAnimToggleBtn) fsAnimToggleBtn.title = title;
  }

  if (animToggleBtn) animToggleBtn.addEventListener('click', toggleEmojiAnimations);
  if (fsAnimToggleBtn) fsAnimToggleBtn.addEventListener('click', toggleEmojiAnimations);
}

function setupFullscreenReactionButtons() {
  document.querySelectorAll('.fs-reaction-btn').forEach(function(btn) {
    // Skip the animation toggle button
    if (btn.id === 'fsAnimToggleBtn') return;
    btn.addEventListener('click', function(e) {
      triggerReaction(e);
    });
  });
}
