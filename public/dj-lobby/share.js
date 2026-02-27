// public/dj-lobby/share.js
// DJ Lobby — share stream modal, thumbnail capture, social media sharing

var ctx = null;

// Module-local state
var capturedThumbnailBlob = null;
var capturedThumbnailUrl = null;
var shareThumbBlob = null;
var shareThumbUrl = null;

export function init(context) {
  ctx = context;
}

export function captureVideoThumbnail() {
  var video = document.getElementById('hlsVideo');
  var btn = document.getElementById('captureThumbBtn');
  var preview = document.getElementById('thumbnailPreview');
  var previewImg = document.getElementById('capturedThumb');
  var twitterBtn = document.getElementById('shareTwitterBtn');
  var facebookBtn = document.getElementById('shareFacebookBtn');

  if (!video || video.paused || !video.videoWidth) {
    alert('No video playing to capture');
    return;
  }

  try {
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var canvasCtx = canvas.getContext('2d');
    canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(function(blob) {
      if (!blob) return;

      capturedThumbnailBlob = blob;

      if (capturedThumbnailUrl) {
        URL.revokeObjectURL(capturedThumbnailUrl);
      }

      capturedThumbnailUrl = URL.createObjectURL(blob);

      if (previewImg && preview) {
        previewImg.src = capturedThumbnailUrl;
        preview.classList.remove('hidden');
      }

      if (twitterBtn) twitterBtn.disabled = false;
      if (facebookBtn) facebookBtn.disabled = false;

      var captureText = btn.querySelector('.capture-text');
      if (captureText) {
        captureText.textContent = '\u2713 Captured';
        setTimeout(function() {
          captureText.textContent = 'Capture';
        }, 1500);
      }
    }, 'image/jpeg', 0.9);
  } catch (e) {
    console.error('Thumbnail capture failed:', e);
    alert('Failed to capture thumbnail');
  }
}

export function clearThumbnail() {
  var preview = document.getElementById('thumbnailPreview');
  var previewImg = document.getElementById('capturedThumb');
  var twitterBtn = document.getElementById('shareTwitterBtn');
  var facebookBtn = document.getElementById('shareFacebookBtn');

  if (capturedThumbnailUrl) {
    URL.revokeObjectURL(capturedThumbnailUrl);
    capturedThumbnailUrl = null;
  }
  capturedThumbnailBlob = null;

  if (preview) preview.classList.add('hidden');
  if (previewImg) previewImg.src = '';
  if (twitterBtn) twitterBtn.disabled = true;
  if (facebookBtn) facebookBtn.disabled = true;
}

export function shareToTwitter() {
  var postText = document.getElementById('socialPostText')?.value || '';
  var text = encodeURIComponent(postText || 'Live now on Fresh Wax! \uD83C\uDFA7\uD83D\uDD0A');
  var url = encodeURIComponent(window.location.origin + '/live');
  window.open('https://x.com/intent/tweet?text=' + text + '&url=' + url, '_blank', 'noopener,noreferrer,width=550,height=420');
}

export function shareToFacebook() {
  var url = encodeURIComponent(window.location.origin + '/live');
  window.open('https://www.facebook.com/sharer/sharer.php?u=' + url, '_blank', 'noopener,noreferrer,width=550,height=420');
}

export function openShareModal() {
  var modal = document.getElementById('shareStreamModal');
  if (!modal) return;

  var djNameEl = document.getElementById('shareDjName');
  var titleEl = document.getElementById('shareStreamTitle');
  var genreEl = document.getElementById('shareStreamGenre');
  var postTextEl = document.getElementById('sharePostText');

  var userInfo = ctx ? ctx.getUserInfo() : null;
  if (djNameEl) djNameEl.textContent = userInfo?.name || 'DJ';
  if (titleEl) titleEl.textContent = document.getElementById('inlineStreamTitle')?.value || 'Live Session';
  if (genreEl) genreEl.textContent = document.getElementById('inlineStreamGenre')?.value || 'Jungle / D&B';

  if (postTextEl && !postTextEl.value) {
    var djName = userInfo?.name || 'DJ';
    var title = document.getElementById('inlineStreamTitle')?.value || 'Live Session';
    postTextEl.value = '\uD83C\uDFA7 I\'m live on Fresh Wax!\n\n' + title + '\n\nTune in now \uD83D\uDD0A';
    updateCharCount();
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

export function closeShareModal() {
  var modal = document.getElementById('shareStreamModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

export function captureShareThumbnail() {
  var video = document.getElementById('hlsVideo');
  var previewEl = document.getElementById('shareThumbPreview');
  var placeholder = document.getElementById('shareThumbPlaceholder');
  var imgEl = document.getElementById('shareThumbImg');
  var captureBtn = document.getElementById('shareCaptureBtn');
  var clearBtn = document.getElementById('shareClearThumbBtn');

  if (!video || video.paused || !video.videoWidth) {
    alert('No video stream available to capture');
    return;
  }

  try {
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var canvasCtx = canvas.getContext('2d');
    canvasCtx.drawImage(video, 0, 0);

    canvas.toBlob(function(blob) {
      if (!blob) {
        alert('Failed to capture thumbnail');
        return;
      }

      if (shareThumbUrl) {
        URL.revokeObjectURL(shareThumbUrl);
      }

      shareThumbBlob = blob;
      shareThumbUrl = URL.createObjectURL(blob);

      if (imgEl) {
        imgEl.src = shareThumbUrl;
        imgEl.classList.remove('hidden');
      }
      if (placeholder) placeholder.classList.add('hidden');
      if (previewEl) previewEl.classList.add('has-image');
      if (clearBtn) clearBtn.classList.remove('hidden');

      if (captureBtn) {
        var originalText = captureBtn.innerHTML;
        captureBtn.innerHTML = '<span>\u2713</span> Captured!';
        setTimeout(function() {
          captureBtn.innerHTML = '<span>\uD83D\uDCF8</span> Capture from Stream';
        }, 1500);
      }
    }, 'image/jpeg', 0.9);
  } catch (e) {
    console.error('Share thumbnail capture failed:', e);
    alert('Failed to capture thumbnail');
  }
}

export function clearShareThumbnail() {
  var previewEl = document.getElementById('shareThumbPreview');
  var placeholder = document.getElementById('shareThumbPlaceholder');
  var imgEl = document.getElementById('shareThumbImg');
  var clearBtn = document.getElementById('shareClearThumbBtn');

  if (shareThumbUrl) {
    URL.revokeObjectURL(shareThumbUrl);
    shareThumbUrl = null;
  }
  shareThumbBlob = null;

  if (imgEl) {
    imgEl.src = '';
    imgEl.classList.add('hidden');
  }
  if (placeholder) placeholder.classList.remove('hidden');
  if (previewEl) previewEl.classList.remove('has-image');
  if (clearBtn) clearBtn.classList.add('hidden');
}

export function updateCharCount() {
  var textEl = document.getElementById('sharePostText');
  var countEl = document.getElementById('shareCharCount');
  if (textEl && countEl) {
    countEl.textContent = textEl.value.length.toString();
  }
}

export function shareToTwitterFromModal() {
  var postText = document.getElementById('sharePostText')?.value || '';
  var text = encodeURIComponent(postText || 'Live now on Fresh Wax! \uD83C\uDFA7\uD83D\uDD0A');
  var url = encodeURIComponent(window.location.origin + '/live');
  window.open('https://x.com/intent/tweet?text=' + text + '&url=' + url, '_blank', 'noopener,noreferrer,width=550,height=420');
}

export function shareToFacebookFromModal() {
  var url = encodeURIComponent(window.location.origin + '/live');
  window.open('https://www.facebook.com/sharer/sharer.php?u=' + url, '_blank', 'noopener,noreferrer,width=550,height=420');
}

export function copyStreamLink() {
  var btn = document.getElementById('shareCopyLink');
  var url = window.location.origin + '/live';

  navigator.clipboard.writeText(url).then(function() {
    if (btn) {
      btn.classList.add('copied');
      var originalHTML = btn.innerHTML;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><span>Copied!</span>';
      setTimeout(function() {
        btn.classList.remove('copied');
        btn.innerHTML = originalHTML;
      }, 2000);
    }
  }).catch(function(err) {
    console.error('Failed to copy:', err);
    alert('Failed to copy link');
  });
}
