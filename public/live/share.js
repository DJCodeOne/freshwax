// public/live/share.js
// Live page — share modal and social sharing module

var currentLiveInfo = null;

export function initShare() {
  // Open share modal
  var shareBtn = document.getElementById('shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', function() {
      var modal = document.getElementById('shareModal');
      if (modal) {
        modal.classList.remove('hidden');
        var input = document.getElementById('shareLinkInput');
        if (input) input.value = getShareUrl();

        // Show native share button if supported
        if (navigator.share) {
          var nativeBtn = document.getElementById('nativeShare');
          if (nativeBtn) nativeBtn.classList.remove('hidden');
        }
      }
    });
  }

  // Close share modal
  var closeBtn = document.getElementById('closeShareModal');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      var modal = document.getElementById('shareModal');
      if (modal) modal.classList.add('hidden');
    });
  }

  // Close share modal on overlay click
  var overlay = document.querySelector('#shareModal .modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', function() {
      var modal = document.getElementById('shareModal');
      if (modal) modal.classList.add('hidden');
    });
  }

  // Copy share link
  var copyBtn = document.getElementById('copyShareLink');
  if (copyBtn) {
    copyBtn.addEventListener('click', function() {
      var input = document.getElementById('shareLinkInput');
      if (input && copyBtn) {
        navigator.clipboard.writeText(input.value);
        copyBtn.textContent = 'Copied!';
        setTimeout(function() { copyBtn.textContent = 'Copy'; }, 2000);
      }
    });
  }

  // Twitter/X share
  var twitterBtn = document.getElementById('shareTwitter');
  if (twitterBtn) {
    twitterBtn.addEventListener('click', function() {
      var text = encodeURIComponent(getShareText());
      var url = encodeURIComponent(getShareUrl());
      window.open('https://x.com/intent/tweet?text=' + text + '&url=' + url, '_blank', 'noopener,noreferrer,width=550,height=420');
    });
  }

  // Facebook share
  var facebookBtn = document.getElementById('shareFacebook');
  if (facebookBtn) {
    facebookBtn.addEventListener('click', function() {
      var shareUrl = getShareUrl();
      var djName = document.getElementById('sharePreviewName');
      var djNameText = (djName && djName.textContent) || 'Fresh Wax DJ';
      var title = encodeURIComponent('LIVE NOW: ' + djNameText + ' on Fresh Wax');
      var description = encodeURIComponent('Tune in now for live jungle, drum & bass, and breakbeat!');
      var url = encodeURIComponent(shareUrl);
      window.open(
        'https://www.facebook.com/dialog/feed?app_id=966242223397117&link=' + url + '&name=' + title + '&description=' + description + '&redirect_uri=' + encodeURIComponent(window.location.origin + '/live'),
        '_blank',
        'noopener,noreferrer,width=626,height=436'
      );
    });
  }

  // WhatsApp share
  var whatsAppBtn = document.getElementById('shareWhatsApp');
  if (whatsAppBtn) {
    whatsAppBtn.addEventListener('click', function() {
      var text = encodeURIComponent(getShareText() + ' ' + getShareUrl());
      window.open('https://wa.me/?text=' + text, '_blank', 'noopener,noreferrer');
    });
  }

  // Telegram share
  var telegramBtn = document.getElementById('shareTelegram');
  if (telegramBtn) {
    telegramBtn.addEventListener('click', function() {
      var text = encodeURIComponent(getShareText());
      var url = encodeURIComponent(getShareUrl());
      window.open('https://t.me/share/url?url=' + url + '&text=' + text, '_blank', 'noopener,noreferrer');
    });
  }

  // Native share (mobile)
  var nativeShareBtn = document.getElementById('nativeShare');
  if (nativeShareBtn) {
    nativeShareBtn.addEventListener('click', async function() {
      if (navigator.share) {
        var modal = document.getElementById('shareModal');
        if (modal) modal.classList.add('hidden');
        try {
          await navigator.share({
            title: 'Fresh Wax Live Stream',
            text: getShareText(),
            url: getShareUrl()
          });
        } catch (e) {
          // Share cancelled
        }
      }
    });
  }

  // Make updateSharePreview available globally
  window.updateSharePreview = updateSharePreview;
}

export function updateSharePreview(djName, djAvatar, crew) {
  currentLiveInfo = { djName: djName, djAvatar: djAvatar, crew: crew };
  var nameEl = document.getElementById('sharePreviewName');
  var avatarEl = document.getElementById('sharePreviewAvatar');
  var crewEl = document.getElementById('sharePreviewCrew');
  if (nameEl) nameEl.textContent = djName || 'Live Now';
  if (avatarEl) avatarEl.src = djAvatar || '/place-holder.webp';
  if (crewEl) crewEl.textContent = crew || 'Fresh Wax Live Stream';
}

function getShareUrl() {
  return window.location.origin + '/live';
}

function getShareText() {
  if (currentLiveInfo) {
    return currentLiveInfo.djName + ' is LIVE NOW on Fresh Wax!';
  }
  return 'Fresh Wax Live Stream';
}
