// public/live/shoutout.js
// Live page — shoutout modal and marquee module

var escapeHtml = null;
var shoutoutQueue = [];
var isShoutoutPlaying = false;
var shoutoutFocusTrapHandler = null;
var shoutoutPreviousFocus = null;

// Focus trap helper for shoutout modal
function trapFocusInShoutout(modalEl) {
  var selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var focusableEls = modalEl.querySelectorAll(selector);
  if (focusableEls.length === 0) return;
  var firstEl = focusableEls[0];
  var lastEl = focusableEls[focusableEls.length - 1];

  shoutoutFocusTrapHandler = function(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  };
  modalEl.addEventListener('keydown', shoutoutFocusTrapHandler);
}

function removeFocusTrapFromShoutout(modalEl) {
  if (shoutoutFocusTrapHandler) {
    modalEl.removeEventListener('keydown', shoutoutFocusTrapHandler);
    shoutoutFocusTrapHandler = null;
  }
}

function closeShoutoutModal(modal, inputEl, charCountEl, sendBtn) {
  if (modal) {
    removeFocusTrapFromShoutout(modal);
    modal.classList.add('hidden');
  }
  if (inputEl) inputEl.value = '';
  if (charCountEl) charCountEl.textContent = '0';
  if (sendBtn) sendBtn.disabled = true;
  if (shoutoutPreviousFocus && typeof shoutoutPreviousFocus.focus === 'function') {
    shoutoutPreviousFocus.focus();
    shoutoutPreviousFocus = null;
  }
}

export function initShoutout(deps) {
  escapeHtml = deps.escapeHtml;

  var shoutoutBtn = document.getElementById('shoutoutBtn');
  var shoutoutModal = document.getElementById('shoutoutModal');
  var closeShoutoutModalBtn = document.getElementById('closeShoutoutModal');
  var shoutoutInput = document.getElementById('shoutoutInput');
  var shoutoutCharCount = document.getElementById('shoutoutCharCount');
  var sendShoutoutBtn = document.getElementById('sendShoutoutBtn');

  // Open shoutout modal
  if (shoutoutBtn) {
    shoutoutBtn.addEventListener('click', function() {
      var isLoggedIn = window.currentUserInfo && window.currentUserInfo.loggedIn;
      if (!isLoggedIn) {
        alert('Please sign in to send a shoutout');
        return;
      }
      shoutoutPreviousFocus = document.activeElement;
      if (shoutoutModal) {
        shoutoutModal.classList.remove('hidden');
        trapFocusInShoutout(shoutoutModal);
      }
      if (shoutoutInput) shoutoutInput.focus();
    });
  }

  // Close shoutout modal
  if (closeShoutoutModalBtn) {
    closeShoutoutModalBtn.addEventListener('click', function() {
      closeShoutoutModal(shoutoutModal, shoutoutInput, shoutoutCharCount, sendShoutoutBtn);
    });
  }

  // Close on overlay click
  var overlay = shoutoutModal && shoutoutModal.querySelector('.modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', function() {
      closeShoutoutModal(shoutoutModal, shoutoutInput, shoutoutCharCount, sendShoutoutBtn);
    });
  }

  // Close shoutout modal on Escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && shoutoutModal && !shoutoutModal.classList.contains('hidden')) {
      closeShoutoutModal(shoutoutModal, shoutoutInput, shoutoutCharCount, sendShoutoutBtn);
    }
  });

  // Character count and enable/disable send button
  if (shoutoutInput) {
    shoutoutInput.addEventListener('input', function() {
      var len = shoutoutInput.value.length;
      if (shoutoutCharCount) shoutoutCharCount.textContent = len;
      if (sendShoutoutBtn) sendShoutoutBtn.disabled = len === 0;
    });
  }

  // Emoji buttons
  document.querySelectorAll('.shoutout-emoji').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (shoutoutInput && shoutoutInput.value.length < 30) {
        var emoji = btn.dataset.emoji;
        var remaining = 30 - shoutoutInput.value.length;
        if (emoji.length <= remaining) {
          shoutoutInput.value += emoji;
          shoutoutInput.dispatchEvent(new Event('input'));
          shoutoutInput.focus();
        }
      }
    });
  });

  // Send shoutout
  if (sendShoutoutBtn) {
    sendShoutoutBtn.addEventListener('click', async function() {
      var message = shoutoutInput && shoutoutInput.value.trim();
      if (!message) return;

      // Use displayName for shoutouts
      var userName = (window.currentUserInfo && (window.currentUserInfo.displayName || window.currentUserInfo.name)) || 'Anonymous';
      var userId = (window.currentUserInfo && window.currentUserInfo.id) || null;

      // Disable button while sending
      sendShoutoutBtn.disabled = true;
      sendShoutoutBtn.innerHTML = '<span>Sending...</span>';

      try {
        // Get current stream ID
        var streamId = window.currentStreamId || 'playlist-global';

        // Send via API to broadcast to all viewers
        var shoutToken = null;
        try { shoutToken = await window.firebaseAuth.currentUser.getIdToken(); } catch (e) { /* ignore */ }
        var response = await fetch('/api/livestream/react/', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, shoutToken ? { 'Authorization': 'Bearer ' + shoutToken } : {}),
          body: JSON.stringify({
            action: 'shoutout',
            streamId: streamId,
            userId: userId,
            userName: userName,
            message: message
          })
        });

        if (!response.ok) {
          console.error('Shoutout send failed:', response.status);
        }
      } catch (e) {
        console.error('Shoutout error:', e);
      }

      // Close modal, restore focus, and reset
      if (shoutoutModal) removeFocusTrapFromShoutout(shoutoutModal);
      if (shoutoutModal) shoutoutModal.classList.add('hidden');
      if (shoutoutInput) shoutoutInput.value = '';
      if (shoutoutCharCount) shoutoutCharCount.textContent = '0';
      sendShoutoutBtn.disabled = false;
      sendShoutoutBtn.innerHTML = '<span>Send Shoutout</span><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
      if (shoutoutPreviousFocus && typeof shoutoutPreviousFocus.focus === 'function') {
        shoutoutPreviousFocus.focus();
        shoutoutPreviousFocus = null;
      }
    });
  }

  // Listen for incoming shoutouts from Pusher
  window.handleIncomingShoutout = function(data) {
    shoutoutQueue.push({ name: data.name, message: data.message });
    playNextShoutout();
  };
}

function playNextShoutout() {
  var shoutoutTrack = document.getElementById('shoutoutTrack');
  if (isShoutoutPlaying || shoutoutQueue.length === 0) return;

  isShoutoutPlaying = true;
  var shoutout = shoutoutQueue.shift();

  if (shoutoutTrack) {
    shoutoutTrack.innerHTML = '<span class="shoutout-message"><span class="shoutout-name">' + escapeHtml(shoutout.name) + ':</span> ' + escapeHtml(shoutout.message) + '</span>';
    shoutoutTrack.classList.remove('scrolling');

    // Trigger reflow to restart animation
    void shoutoutTrack.offsetWidth;
    shoutoutTrack.classList.add('scrolling');

    // After animation ends, check for more shoutouts
    setTimeout(function() {
      isShoutoutPlaying = false;
      if (shoutoutQueue.length > 0) {
        playNextShoutout();
      } else {
        // Reset to placeholder
        shoutoutTrack.classList.remove('scrolling');
        shoutoutTrack.innerHTML = '<span class="shoutout-placeholder">\uD83C\uDF89 Send a shoutout to appear here!</span>';
      }
    }, 30000);
  }
}
