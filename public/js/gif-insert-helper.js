/**
 * GIF INSERT HELPER
 * Instantly displays selected GIF in chat or comment box
 * No text, no delay - just the GIF
 */

(function() {
  'use strict';

  // Insert GIF into chat messages
  window.insertGifToChat = function(gif, options = {}) {
    const {
      container = document.getElementById('chat-messages'),
      sender = 'You',
      sendToServer = null  // Optional callback to send to server
    } = options;

    if (!container || !gif?.url) return;

    // Create message element
    const msg = document.createElement('div');
    msg.className = 'chat-message chat-message-gif';
    msg.innerHTML = `
      <div class="chat-sender">${escapeHtml(sender)}</div>
      <div class="chat-gif-wrap">
        <img src="${gif.url}" alt="GIF" class="chat-gif" loading="eager" />
      </div>
    `;

    // Add to chat instantly
    container.appendChild(msg);
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;

    // Send to server if callback provided
    if (sendToServer) {
      sendToServer({
        type: 'gif',
        url: gif.url,
        source: gif.source
      });
    }
  };

  // Insert GIF into comment textarea/input (as just the URL or rendered)
  window.insertGifToComment = function(gif, options = {}) {
    const {
      input = document.getElementById('comment-input'),
      preview = document.getElementById('comment-gif-preview'),
      mode = 'preview'  // 'preview' shows image, 'url' inserts URL text
    } = options;

    if (!gif?.url) return;

    if (mode === 'url' && input) {
      // Insert URL into text input
      input.value = gif.url;
      input.focus();
    } else if (mode === 'preview' && preview) {
      // Show preview image
      preview.innerHTML = `
        <div class="gif-preview-wrap">
          <img src="${gif.url}" alt="GIF" />
          <button class="gif-preview-remove" onclick="removeGifPreview()">✕</button>
        </div>
      `;
      preview.dataset.gifUrl = gif.url;
      preview.dataset.gifSource = gif.source;
    }
  };

  // Remove GIF preview
  window.removeGifPreview = function() {
    const preview = document.getElementById('comment-gif-preview');
    if (preview) {
      preview.innerHTML = '';
      delete preview.dataset.gifUrl;
      delete preview.dataset.gifSource;
    }
  };

  // Get attached GIF data (for form submission)
  window.getAttachedGif = function() {
    const preview = document.getElementById('comment-gif-preview');
    if (preview?.dataset.gifUrl) {
      return {
        url: preview.dataset.gifUrl,
        source: preview.dataset.gifSource
      };
    }
    return null;
  };

  // Helper
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

})();


/* =====================================================
   CSS STYLES FOR CHAT GIFS
   ===================================================== */

/*
.chat-message-gif {
  padding: 0.5rem;
}

.chat-sender {
  font-size: 0.8rem;
  font-weight: 600;
  color: #22c55e;
  margin-bottom: 0.25rem;
}

.chat-gif-wrap {
  display: inline-block;
  max-width: 250px;
}

.chat-gif {
  width: 100%;
  height: auto;
  border-radius: 0.5rem;
  display: block;
}

// Comment GIF preview
.gif-preview-wrap {
  position: relative;
  display: inline-block;
  margin: 0.5rem 0;
}

.gif-preview-wrap img {
  max-width: 150px;
  max-height: 150px;
  border-radius: 0.5rem;
}

.gif-preview-remove {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 24px;
  height: 24px;
  background: #ef4444;
  border: none;
  border-radius: 50%;
  color: white;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gif-preview-remove:hover {
  background: #dc2626;
  transform: scale(1.1);
}
*/
