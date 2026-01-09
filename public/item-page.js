// public/item-page.js
// FIXED: Uses lazy audio creation like ReleasePlate.astro
// Audio elements are created on first play click, not pre-rendered

// ========== AUTH HELPER ==========
// Wait for auth to be ready and return the current user
async function getAuthUser() {
  // If authReady promise exists (from Header), wait for it
  if (window.authReady) {
    await window.authReady;
  }
  // Return the authenticated user
  return window.firebaseAuth?.currentUser || window.authUser || null;
}

// ========== CART HELPER FUNCTIONS ==========
function getCustomerId() {
  var cookies = document.cookie.split(';');
  for (var i = 0; i < cookies.length; i++) {
    var cookie = cookies[i].trim();
    var parts = cookie.split('=');
    if (parts[0] === 'customerId' && parts[1]) {
      return parts[1];
    }
  }
  return null;
}

function getCartKey() {
  var customerId = getCustomerId();
  if (!customerId) return null;
  return 'freshwax_cart_' + customerId;
}

function getCart() {
  var key = getCartKey();
  if (!key) return { items: [] };
  
  try {
    var stored = localStorage.getItem(key);
    if (stored) {
      var data = JSON.parse(stored);
      return data.items ? data : { items: data };
    }
  } catch (e) {
    console.error('[Cart] Error parsing cart:', e);
  }
  
  return { items: [] };
}

function saveCartData(items) {
  var key = getCartKey();
  if (!key) return;
  
  var cartData = {
    items: items,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(key, JSON.stringify(cartData));
  window.dispatchEvent(new CustomEvent('cart-updated', { detail: cartData }));
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cartData }));
  updateCartBadgeNow();
}

function addItemToCart(item) {
  var customerId = getCustomerId();
  
  if (!customerId) {
    window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
  
  var cart = getCart();
  var items = cart.items || [];
  
  var existingIndex = -1;
  for (var i = 0; i < items.length; i++) {
    var existing = items[i];
    if (existing.id === item.id && 
        existing.type === item.type &&
        existing.trackId === item.trackId) {
      existingIndex = i;
      break;
    }
  }
  
  if (existingIndex >= 0) {
    items[existingIndex].quantity = (items[existingIndex].quantity || 1) + 1;
  } else {
    items.push({
      id: item.id,
      releaseId: item.id, // For vinyl stock updates
      trackId: item.trackId || null,
      type: item.type,
      format: item.type,
      name: item.name,
      title: item.title,
      artist: item.artist,
      artistId: item.artistId || null, // For Stripe Connect payouts
      price: item.price,
      image: item.image,
      artwork: item.image,
      quantity: 1
    });
  }
  
  saveCartData(items);
  console.log('[Cart] Item added:', item.name, 'Total items:', items.length);
  return true;
}

function updateCartBadgeNow() {
  var cart = getCart();
  var items = cart.items || [];
  var count = 0;
  for (var i = 0; i < items.length; i++) {
    count += items[i].quantity || 1;
  }
  
  var desktopCount = document.getElementById('cart-count');
  var mobileCount = document.getElementById('cart-count-mobile');
  
  [desktopCount, mobileCount].forEach(function(el) {
    if (el) {
      if (count > 0) {
        el.textContent = count.toString();
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
  
  // Also update data-cart-count elements
  document.querySelectorAll('[data-cart-count]').forEach(function(el) {
    el.textContent = count;
    el.style.display = count > 0 ? '' : 'none';
  });
  
  console.log('[Cart] Badge updated, count:', count);
}

function hasFullReleaseInCart(releaseId) {
  var cart = getCart();
  var items = cart.items || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === releaseId && (items[i].type === 'digital' || items[i].type === 'vinyl')) {
      return true;
    }
  }
  return false;
}

function hasTrackInCart(releaseId, trackId) {
  var cart = getCart();
  var items = cart.items || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === releaseId && items[i].trackId === trackId) {
      return true;
    }
  }
  return false;
}
// ========== END CART HELPER FUNCTIONS ==========

// Utility functions
function sanitizeComment(text) {
  text = text.replace(/https?:\/\/[^\s]+/gi, '[link removed]');
  text = text.replace(/www\.[^\s]+/gi, '[link removed]');
  text = text.replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/gi, '[email removed]');
  text = text.replace(/<[^>]*>/g, '');
  return text.trim().substring(0, 300);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Toast notification
function showToast(message) {
  const existing = document.getElementById('fw-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'fw-toast';
  toast.textContent = message;
  toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:fadeInUp 0.3s ease;';
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease';
    setTimeout(() => { toast.remove(); }, 300);
  }, 2000);
}

// Player initialization - FIXED with lazy audio creation
// CLIP RESTRICTION: Play 60 seconds starting at 60s into the track
const CLIP_START_TIME = 60; // Start at 60 seconds into track
const CLIP_DURATION = 60;   // Play for 60 seconds max
const CLIP_END_TIME = CLIP_START_TIME + CLIP_DURATION; // Stop at 120 seconds
const FADE_DURATION = 3;    // Fade in/out over 3 seconds
const FADE_OUT_START = CLIP_END_TIME - FADE_DURATION; // Start fading out 3s before end
const TARGET_VOLUME = 1.0;  // Target volume for playback

function initPlayer() {
  const trackList = document.getElementById('full-track-list');
  if (!trackList) return;

  const playButtons = document.querySelectorAll('.play-button');
  const waveformCanvases = document.querySelectorAll('.track-waveform');

  let currentAudio = null;
  let currentButton = null;
  let currentCanvas = null;

  const bars = 20;
  
  console.log('[Player] Initializing with', playButtons.length, 'play buttons');
  
  function drawWaveform(canvas, progress = 0, isPlaying = false) {
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    if (canvas.width === 0 || canvas.height === 0) {
      canvas.width = 150;
      canvas.height = 40;
    }
    
    const barWidth = (canvas.width / bars) - 1;
    const barGap = 1;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    for (let i = 0; i < bars; i++) {
      const height = (Math.random() * 0.5 + 0.3) * canvas.height;
      const x = i * (barWidth + barGap);
      const y = (canvas.height - height) / 2;
      
      if (isPlaying) {
        ctx.fillStyle = i / bars < progress ? '#dc2626' : '#9ca3af';
      } else {
        ctx.fillStyle = i / bars < progress ? '#6b7280' : '#d1d5db';
      }
      
      ctx.fillRect(x, y, barWidth, height);
    }
  }
  
  // Initialize all waveforms
  waveformCanvases.forEach(canvas => {
    // Skip if already initialized
    if (canvas.hasAttribute('data-waveform-init')) return;
    canvas.setAttribute('data-waveform-init', 'true');
    
    setTimeout(() => {
      drawWaveform(canvas, 0, false);
    }, 100);
    
    canvas.addEventListener('click', (e) => {
      const trackId = canvas.getAttribute('data-track-id');
      const audio = document.querySelector(`.track-audio[data-track-id="${trackId}"]`);

      if (audio && audio.duration && isFinite(audio.duration)) {
        const rect = canvas.getBoundingClientRect();
        const progress = (e.clientX - rect.left) / rect.width;
        // Seek within clip window (60s-120s) - waveform represents only the clip
        const seekTime = CLIP_START_TIME + (progress * CLIP_DURATION);
        audio.currentTime = Math.min(Math.max(seekTime, CLIP_START_TIME), CLIP_END_TIME - 1);
      }
    });
  });
  
  // Play buttons with LAZY AUDIO CREATION
  playButtons.forEach(button => {
    // FIXED: Prevent duplicate event listeners
    if (button.hasAttribute('data-player-init')) {
      console.log('[Player] Button already initialized, skipping');
      return;
    }
    button.setAttribute('data-player-init', 'true');
    
    const trackId = button.getAttribute('data-track-id');
    const releaseId = button.getAttribute('data-release-id');
    const previewUrl = button.getAttribute('data-preview-url');
    const trackTitle = button.getAttribute('data-track-title') || 'Unknown Track';
    
    console.log('[Player] Button setup:', { trackId, previewUrl: previewUrl ? 'YES' : 'NO' });
    
    button.addEventListener('click', () => {
      console.log('[Player] Play clicked:', trackId, 'URL:', previewUrl);
      
      // Check if preview URL exists
      if (!previewUrl) {
        alert('Preview not available for this track');
        return;
      }
      
      // *** NOTIFY AUDIOMANAGER - pause mini player ***
      if (window.AudioManager) {
        window.AudioManager.onTracklistPreviewPlay();
      }
      
      const canvas = document.querySelector(`.track-waveform[data-track-id="${trackId}"]`);
      const playIcon = button.querySelector('.play-icon');
      const pauseIcon = button.querySelector('.pause-icon');
      
      // Get or create audio element (LAZY CREATION)
      let audio = document.querySelector(`.track-audio[data-track-id="${trackId}"]`);
      
      if (!audio) {
        // Create audio element on first click
        audio = document.createElement('audio');
        audio.className = 'hidden track-audio';
        audio.setAttribute('data-track-id', trackId);
        audio.setAttribute('data-release-id', releaseId);
        audio.preload = 'none';
        audio.src = previewUrl;
        document.getElementById('full-track-list').appendChild(audio);

        console.log('[Player] Created audio element for:', trackTitle, 'src:', previewUrl);

        // Set up event handlers
        audio.addEventListener('timeupdate', () => {
          if (audio === currentAudio && audio.duration && isFinite(audio.duration)) {
            const currentTime = audio.currentTime;

            // CLIP RESTRICTION: Stop playback at CLIP_END_TIME (120s)
            if (currentTime >= CLIP_END_TIME) {
              console.log('[Player] Clip limit reached (60s preview), stopping');
              audio.pause();
              audio.volume = TARGET_VOLUME; // Reset volume after fade
              audio.currentTime = CLIP_START_TIME; // Reset to clip start
              if (playIcon) playIcon.classList.remove('hidden');
              if (pauseIcon) pauseIcon.classList.add('hidden');
              if (canvas) drawWaveform(canvas, 0, false);
              currentAudio = null;
              currentButton = null;
              currentCanvas = null;

              // Show toast notification
              showToast('60 second preview ended');

              if (window.AudioManager) {
                window.AudioManager.onTracklistPreviewStop();
              }
              return;
            }

            // FADE IN: First 3 seconds of clip (60s to 63s)
            if (currentTime >= CLIP_START_TIME && currentTime < CLIP_START_TIME + FADE_DURATION) {
              const fadeInProgress = (currentTime - CLIP_START_TIME) / FADE_DURATION;
              audio.volume = TARGET_VOLUME * fadeInProgress;
            }
            // FADE OUT: Last 3 seconds of clip (117s to 120s)
            else if (currentTime >= FADE_OUT_START) {
              const fadeOutProgress = (CLIP_END_TIME - currentTime) / FADE_DURATION;
              audio.volume = TARGET_VOLUME * Math.max(0, fadeOutProgress);
            }
            // Normal volume in between
            else {
              audio.volume = TARGET_VOLUME;
            }

            // Show clip progress on waveform (60s-120s = 0%-100%)
            if (canvas) {
              const clipProgress = (currentTime - CLIP_START_TIME) / CLIP_DURATION;
              drawWaveform(canvas, Math.max(0, Math.min(1, clipProgress)), !audio.paused);
            }
          }
        });

        audio.addEventListener('ended', () => {
          console.log('[Player] Track ended:', trackId);
          if (playIcon) playIcon.classList.remove('hidden');
          if (pauseIcon) pauseIcon.classList.add('hidden');
          if (canvas) drawWaveform(canvas, 0, false);
          currentAudio = null;
          currentButton = null;
          currentCanvas = null;

          // *** NOTIFY AUDIOMANAGER - allow mini player to resume ***
          if (window.AudioManager) {
            window.AudioManager.onTracklistPreviewStop();
          }
        });

        audio.addEventListener('loadedmetadata', () => {
          console.log('[Player] Metadata loaded:', { trackId, duration: audio.duration });
          // Set starting position to 60 seconds (or 0 if track is shorter)
          if (audio.duration > CLIP_START_TIME) {
            audio.currentTime = CLIP_START_TIME;
          }
        });

        audio.addEventListener('error', (e) => {
          console.error('[Player] Audio error:', { trackId, error: e, src: audio.src });
        });
      }
      
      // Toggle play/pause for same track
      if (currentAudio === audio && !audio.paused) {
        console.log('[Player] Pausing current track');
        audio.pause();
        if (playIcon) playIcon.classList.remove('hidden');
        if (pauseIcon) pauseIcon.classList.add('hidden');
        
        // *** NOTIFY AUDIOMANAGER - track paused ***
        if (window.AudioManager) {
          window.AudioManager.onTracklistPreviewStop();
        }
        return;
      }
      
      // Stop any other playing audio
      if (currentAudio && currentAudio !== audio) {
        console.log('[Player] Stopping previous track');
        currentAudio.pause();
        currentAudio.currentTime = 0;
        if (currentButton) {
          currentButton.querySelector('.play-icon')?.classList.remove('hidden');
          currentButton.querySelector('.pause-icon')?.classList.add('hidden');
        }
        if (currentCanvas) {
          drawWaveform(currentCanvas, 0, false);
        }
      }
      
      // Also stop any audio in ReleasePlate cards (if on same page somehow)
      document.querySelectorAll('[data-release] .track-audio').forEach(a => {
        if (!a.paused) {
          a.pause();
          a.currentTime = 0;
        }
      });
      
      currentAudio = audio;
      currentButton = button;
      currentCanvas = canvas;

      // Ensure we start at the clip start position (60s)
      if (audio.duration && audio.duration > CLIP_START_TIME) {
        if (audio.currentTime < CLIP_START_TIME || audio.currentTime >= CLIP_END_TIME) {
          audio.currentTime = CLIP_START_TIME;
          audio.volume = 0; // Start at 0 for fade in
        }
      } else {
        audio.volume = 0; // Start at 0 for fade in
      }

      console.log('[Player] Playing track:', trackTitle, 'from', CLIP_START_TIME + 's (60s preview)');
      audio.play().then(() => {
        console.log('[Player] Playback started');
        if (playIcon) playIcon.classList.add('hidden');
        if (pauseIcon) pauseIcon.classList.remove('hidden');
        showToast('Playing 60 second preview');
      }).catch(err => {
        console.error('[Player] Play error:', err);
        audio.volume = TARGET_VOLUME; // Reset volume on error
        alert('Could not play preview. The file may be unavailable.');

        // *** NOTIFY AUDIOMANAGER - play failed ***
        if (window.AudioManager) {
          window.AudioManager.onTracklistPreviewStop();
        }
      });
    });
  });
}

async function initRatings() {
  const releaseId = document.querySelector('[data-release-id]')?.getAttribute('data-release-id');
  if (!releaseId) return;
  
  // Prevent duplicate initialization
  if (document.querySelector('.rating-star[data-rating-init]')) return;

  // OPTIMIZED: Use SSR data if available instead of fetching
  const ssrData = window.__SSR_RELEASE_DATA__;
  if (ssrData && ssrData.releaseId === releaseId && ssrData.ratings) {
    console.log('[Ratings] Using SSR data, skipping fetch');
    const data = ssrData.ratings;
    
    const ratingValue = document.querySelector('.rating-value');
    if (ratingValue) {
      ratingValue.textContent = (data.average || 0).toFixed(1);
      const countSpan = ratingValue.nextElementSibling;
      if (countSpan) countSpan.textContent = ` (${data.count || 0})`;
    }
    
    const stars = document.querySelectorAll('.rating-star');
    stars.forEach(star => {
      const starNum = parseInt(star.getAttribute('data-star') || '0');
      const svg = star.querySelector('svg');
      if (svg) {
        svg.setAttribute('fill', starNum <= Math.round(data.average || 0) ? 'currentColor' : 'none');
      }
    });
  } else {
    // Fallback: fetch from API if no SSR data
    try {
      const res = await fetch(`/api/get-ratings?releaseId=${releaseId}`);
      const data = await res.json();
      
      if (data.success) {
        const ratingValue = document.querySelector('.rating-value');
        if (ratingValue) {
          ratingValue.textContent = data.average.toFixed(1);
          const countSpan = ratingValue.nextElementSibling;
          if (countSpan) countSpan.textContent = ` (${data.count})`;
        }
        
        const stars = document.querySelectorAll('.rating-star');
        stars.forEach(star => {
          const starNum = parseInt(star.getAttribute('data-star') || '0');
          const svg = star.querySelector('svg');
          if (svg) {
            svg.setAttribute('fill', starNum <= Math.round(data.average) ? 'currentColor' : 'none');
          }
        });
      }
    } catch (err) {
      console.error('[Ratings] Failed to fetch:', err);
    }
  }

  document.querySelectorAll('.rating-star').forEach(star => {
    // Prevent duplicate listeners
    if (star.hasAttribute('data-rating-init')) return;
    star.setAttribute('data-rating-init', 'true');
    
    star.addEventListener('click', async () => {
      const releaseId = star.getAttribute('data-release-id');
      const rating = parseInt(star.getAttribute('data-star') || '0');
      
      // Wait for auth to be ready
      const user = await getAuthUser();
      
      if (!user) {
        alert('Please log in to rate releases. You can log in as either a customer or artist.');
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }

      // Check email verification for new users
      if (window.FreshWax?.checkEmailVerified) {
        const verified = await window.FreshWax.checkEmailVerified('rate releases');
        if (!verified) return;
      }

      try {
        const response = await fetch('/api/rate-release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ releaseId, rating, userId: user.uid })
        });
        
        const data = await response.json();
        
        if (data.success) {
          const ratingValue = document.querySelector('.rating-value');
          if (ratingValue) {
            ratingValue.textContent = data.newRating.toFixed(1);
            const countSpan = ratingValue.nextElementSibling;
            if (countSpan) countSpan.textContent = ` (${data.ratingsCount})`;
          }
          
          const stars = document.querySelectorAll('.rating-star');
          stars.forEach(s => {
            const starNum = parseInt(s.getAttribute('data-star') || '0');
            const svg = s.querySelector('svg');
            if (svg) {
              svg.setAttribute('fill', starNum <= Math.round(data.newRating) ? 'currentColor' : 'none');
            }
          });
        } else {
          alert(data.error || 'Failed to save rating');
        }
      } catch (error) {
        console.error('[Rating] Error:', error);
        alert('Failed to save rating. Please try again.');
      }
    });
  });
}

async function initComments() {
  const releaseId = document.querySelector('[data-release-id]')?.getAttribute('data-release-id');
  if (!releaseId) {
    console.log('[Comments] No release ID found');
    return;
  }

  // Prevent duplicate initialization
  const submitBtn = document.getElementById('submit-comment-btn');
  if (submitBtn?.hasAttribute('data-comments-init')) return;
  if (submitBtn) submitBtn.setAttribute('data-comments-init', 'true');

  console.log('[Comments] Initializing for release:', releaseId);

  const commentText = document.getElementById('comment-text');
  const commentUsername = document.getElementById('comment-username');
  const charCount = document.getElementById('char-count');
  const commentsList = document.getElementById('comments-list');

  console.log('[Comments] Elements found:', {
    commentText: !!commentText,
    commentUsername: !!commentUsername,
    submitBtn: !!submitBtn,
    charCount: !!charCount,
    commentsList: !!commentsList
  });

  // Function to update username field
  async function updateUsernameField() {
    // Wait for auth to be ready
    const user = await getAuthUser();
    
    console.log('[Comments] Checking auth state:', { 
      user: user,
      displayName: user?.displayName,
      email: user?.email
    });
    
    if (user && commentUsername) {
      const fullName = user.displayName || user.email?.split('@')[0] || 'User';
      const firstName = fullName.split(' ')[0];
      console.log('[Comments] Setting username to:', firstName);
      commentUsername.value = firstName;
      commentUsername.classList.add('bg-gray-100', 'cursor-not-allowed');
      commentUsername.classList.remove('bg-white');
      commentUsername.setAttribute('readonly', 'true');
      commentUsername.placeholder = '';
    } else {
      console.log('[Comments] User not logged in');
      if (commentUsername) {
        commentUsername.value = '';
        commentUsername.placeholder = 'Login to make comments';
        commentUsername.classList.add('bg-gray-100', 'cursor-not-allowed');
        commentUsername.classList.remove('bg-white');
        commentUsername.setAttribute('readonly', 'true');
      }
    }
  }

  updateUsernameField();

  // Also listen for auth state changes after initial load
  if (window.firebaseAuth) {
    window.firebaseAuth.onAuthStateChanged((user) => {
      console.log('[Comments] Auth state changed:', user);
      updateUsernameField();
    });
  }

  async function loadComments() {
    if (!commentsList) {
      console.error('[Comments] Comments list element not found');
      return;
    }

    console.log('[Comments] Loading comments...');

    try {
      const response = await fetch(`/api/get-comments?releaseId=${releaseId}`);
      const data = await response.json();
      
      console.log('[Comments] API response:', data);
      
      if (data.success && data.comments && data.comments.length > 0) {
        const sortedComments = data.comments.sort((a, b) => {
          const dateA = new Date(a.timestamp || a.createdAt || 0);
          const dateB = new Date(b.timestamp || b.createdAt || 0);
          return dateB - dateA;
        });
        
        console.log('[Comments] Displaying', sortedComments.length, 'comments');
        
        commentsList.innerHTML = sortedComments.map((comment) => {
          const commentText = comment.comment || comment.text || '';
          const username = comment.userName || comment.username || 'Anonymous';
          const timestamp = comment.timestamp || comment.createdAt || new Date().toISOString();
          const userInitial = username.charAt(0).toUpperCase();
          const formattedDate = new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          
          return `
            <div class="comment-item p-3 bg-white border-2 border-gray-300 hover:border-gray-400 transition-all rounded">
              <div class="flex items-start gap-3">
                <div class="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center flex-shrink-0 border-2 border-black">
                  <span class="text-white font-black text-sm">${userInitial}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-start gap-2">
                    <span class="font-black text-black text-sm uppercase">${escapeHtml(username)}</span>
                    <span class="text-xs text-gray-500 font-semibold">${formattedDate}</span>
                  </div>
                  <p class="text-gray-800 font-semibold leading-relaxed text-sm mt-1">${escapeHtml(commentText)}</p>
                </div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        console.log('[Comments] No comments found');
        commentsList.innerHTML = '<p class="text-center text-gray-500 py-8 font-bold">No comments yet. Be the first!</p>';
      }
    } catch (error) {
      console.error('[Comments] Error loading:', error);
      commentsList.innerHTML = '<p class="text-center text-red-600 py-8">Failed to load comments</p>';
    }
  }

  if (commentText && charCount) {
    commentText.addEventListener('input', () => {
      charCount.textContent = commentText.value.length.toString();
    });
  }

  document.querySelectorAll('.emoji-btn').forEach(btn => {
    // Prevent duplicate listeners
    if (btn.hasAttribute('data-emoji-init')) return;
    btn.setAttribute('data-emoji-init', 'true');
    
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      if (commentText && emoji) {
        const start = commentText.selectionStart || 0;
        const end = commentText.selectionEnd || 0;
        const text = commentText.value;
        
        const newText = text.substring(0, start) + emoji + text.substring(end);
        
        if (newText.length <= 300) {
          commentText.value = newText;
          const newPos = start + emoji.length;
          commentText.setSelectionRange(newPos, newPos);
          commentText.focus();
          
          if (charCount) {
            charCount.textContent = newText.length.toString();
          }
        }
      }
    });
  });

  await loadComments();

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      console.log('[Comments] Submit button clicked');
      
      // Wait for auth to be ready
      const user = await getAuthUser();
      
      if (!user) {
        alert('Please log in to comment. You can log in as either a customer or artist.');
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      
      const text = commentText?.value.trim();
      
      if (!text) {
        alert('Please enter a comment');
        return;
      }
      
      if (text.length > 300) {
        alert('Comment is too long (max 300 characters)');
        return;
      }
      
      const sanitizedText = sanitizeComment(text);
      const username = commentUsername?.value.trim() || 'Anonymous';
      
      console.log('[Comments] Submitting comment:', { username, text: sanitizedText });
      
      try {
        submitBtn.setAttribute('disabled', 'true');
        submitBtn.textContent = 'Posting...';
        
        const response = await fetch('/api/add-comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            releaseId,
            userName: username.substring(0, 30),
            comment: sanitizedText,
            userId: user.uid
          })
        });
        
        const data = await response.json();
        
        console.log('[Comments] Submit response:', data);
        
        if (data.success) {
          if (commentText) commentText.value = '';
          if (charCount) charCount.textContent = '0';
          
          updateUsernameField();
          
          console.log('[Comments] Reloading comments after successful post');
          await loadComments();
          
          alert('Comment posted successfully!');
        } else {
          alert('Failed to post comment: ' + (data.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('[Comments] Error posting:', error);
        alert('Failed to post comment. Please try again.');
      } finally {
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = 'Post Comment';
      }
    });
  }
}

function initShare() {
  const shareModal = document.getElementById('share-modal');
  if (!shareModal || shareModal.hasAttribute('data-share-init')) return;
  shareModal.setAttribute('data-share-init', 'true');

  const shareModalClose = document.getElementById('share-modal-close');
  const shareModalBackdrop = document.getElementById('share-modal-backdrop');
  const shareUrlInput = document.getElementById('share-url-input');
  const copyUrlButton = document.getElementById('copy-url-button');
  const copyBtnText = document.getElementById('copy-btn-text');
  const copyFeedback = document.getElementById('copy-feedback');
  const shareModalTitle = document.getElementById('share-modal-title');
  const shareModalArtist = document.getElementById('share-modal-artist');
  const shareModalArtwork = document.getElementById('share-modal-artwork');
  const nativeShareBtn = document.getElementById('native-share-btn');

  // Social share buttons
  const shareTwitter = document.getElementById('share-twitter');
  const shareFacebook = document.getElementById('share-facebook');
  const shareWhatsapp = document.getElementById('share-whatsapp');
  const shareTelegram = document.getElementById('share-telegram');
  const shareReddit = document.getElementById('share-reddit');

  // Store current share data for social buttons
  window.currentShareData = null;

  // Show native share button if supported
  if (navigator.share) {
    nativeShareBtn?.classList.remove('hidden');
    nativeShareBtn?.classList.add('flex');
  }

  document.querySelectorAll('.share-button').forEach(button => {
    if (button.hasAttribute('data-share-btn-init')) return;
    button.setAttribute('data-share-btn-init', 'true');

    button.addEventListener('click', () => {
      const releaseId = button.getAttribute('data-release-id');
      const title = button.getAttribute('data-title');
      const artist = button.getAttribute('data-artist');
      const artwork = button.getAttribute('data-artwork') || '/place-holder.webp';
      const url = `${window.location.origin}/item/${releaseId}`;

      // Store share data
      window.currentShareData = { url, title, artist, artwork };

      if (shareModalTitle) shareModalTitle.textContent = title || '';
      if (shareModalArtist) shareModalArtist.textContent = artist || '';
      if (shareModalArtwork) shareModalArtwork.src = artwork;
      if (shareUrlInput) shareUrlInput.value = url;
      if (copyFeedback) copyFeedback.classList.add('hidden');
      if (copyBtnText) copyBtnText.textContent = 'Copy';

      // Lock body scroll
      document.body.style.overflow = 'hidden';
      shareModal?.classList.remove('hidden');
    });
  });

  const closeModal = () => {
    document.body.style.overflow = '';
    shareModal?.classList.add('hidden');
  };

  shareModalClose?.addEventListener('click', closeModal);
  shareModalBackdrop?.addEventListener('click', closeModal);

  // Copy button
  copyUrlButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrlInput.value);
      if (copyBtnText) copyBtnText.textContent = 'Copied!';
      if (copyFeedback) copyFeedback.classList.remove('hidden');

      setTimeout(() => {
        if (copyBtnText) copyBtnText.textContent = 'Copy';
        if (copyFeedback) copyFeedback.classList.add('hidden');
      }, 3000);
    } catch (error) {
      if (copyBtnText) copyBtnText.textContent = 'Failed';
      setTimeout(() => {
        if (copyBtnText) copyBtnText.textContent = 'Copy';
      }, 2000);
    }
  });

  // Native share
  nativeShareBtn?.addEventListener('click', async () => {
    if (!window.currentShareData) return;
    const { url, title, artist } = window.currentShareData;
    try {
      await navigator.share({
        title: `${title} by ${artist}`,
        text: `Check out "${title}" by ${artist} on Fresh Wax!`,
        url: url
      });
    } catch (err) {
      // User cancelled or share failed silently
    }
  });

  // Social share buttons
  shareTwitter?.addEventListener('click', () => {
    if (!window.currentShareData) return;
    const { url, title, artist } = window.currentShareData;
    const text = `Check out "${title}" by ${artist} on Fresh Wax! 🎵`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'width=550,height=420');
  });

  shareFacebook?.addEventListener('click', () => {
    if (!window.currentShareData) return;
    const { url } = window.currentShareData;
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank', 'width=550,height=420');
  });

  shareWhatsapp?.addEventListener('click', () => {
    if (!window.currentShareData) return;
    const { url, title, artist } = window.currentShareData;
    const text = `Check out "${title}" by ${artist} on Fresh Wax! 🎵 ${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  });

  shareTelegram?.addEventListener('click', () => {
    if (!window.currentShareData) return;
    const { url, title, artist } = window.currentShareData;
    const text = `Check out "${title}" by ${artist} on Fresh Wax! 🎵`;
    window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank');
  });

  shareReddit?.addEventListener('click', () => {
    if (!window.currentShareData) return;
    const { url, title, artist } = window.currentShareData;
    const redditTitle = `${title} by ${artist}`;
    window.open(`https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(redditTitle)}`, '_blank');
  });

  // Escape key closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shareModal && !shareModal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

function initBio() {
  const bioModal = document.getElementById('bio-modal');
  if (!bioModal || bioModal.hasAttribute('data-bio-init')) return;
  bioModal.setAttribute('data-bio-init', 'true');
  
  const bioModalClose = document.getElementById('bio-modal-close');
  const bioModalBackdrop = document.getElementById('bio-modal-backdrop');
  const bioModalArtist = document.getElementById('bio-modal-artist');
  const bioModalContent = document.getElementById('bio-modal-content');
  
  document.querySelectorAll('.bio-button').forEach(button => {
    if (button.hasAttribute('data-bio-btn-init')) return;
    button.setAttribute('data-bio-btn-init', 'true');
    
    button.addEventListener('click', () => {
      if (button.disabled) return;
      
      const artist = button.getAttribute('data-artist');
      const bio = button.getAttribute('data-bio');
      
      if (!bio) return;
      
      if (bioModalArtist) bioModalArtist.textContent = artist || '';
      if (bioModalContent) bioModalContent.textContent = bio || '';
      
      bioModal?.classList.remove('hidden');
    });
  });
  
  const closeModal = () => {
    bioModal?.classList.add('hidden');
  };
  
  bioModalClose?.addEventListener('click', closeModal);
  bioModalBackdrop?.addEventListener('click', closeModal);
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bioModal && !bioModal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

async function loadSuggestions() {
  const metaDiv = document.getElementById('release-meta');
  const carousel = document.getElementById('suggestions-carousel');
  
  if (!carousel || !metaDiv) return;
  if (carousel.hasAttribute('data-suggestions-init')) return;
  carousel.setAttribute('data-suggestions-init', 'true');

  // Get current release info from meta div
  const releaseId = metaDiv.getAttribute('data-release-id') || '';
  const currentArtist = metaDiv.getAttribute('data-artist-name') || '';
  const currentLabel = metaDiv.getAttribute('data-label-name') || '';
  const currentGenre = metaDiv.getAttribute('data-genre') || '';

  try {
    // OPTIMIZED: Use lightweight suggestions endpoint instead of fetching all releases
    const params = new URLSearchParams({
      currentId: releaseId,
      artist: currentArtist,
      label: currentLabel,
      genre: currentGenre,
      limit: '8'
    });
    
    const response = await fetch(`/api/get-suggestions?${params}`);
    const data = await response.json();
    
    if (data.success && data.suggestions && data.suggestions.length > 0) {
      carousel.innerHTML = data.suggestions.map((release) => {
        const price = release.pricePerSale || 0;
        const matchLabel = release.matchType || '';
        
        return `
          <a href="/item/${release.id}" class="suggestion-card" style="display: block; flex-shrink: 0; width: 144px; background: #1f2937; border-radius: 8px; overflow: hidden; border: 2px solid #374151; scroll-snap-align: start; text-decoration: none;">
            <div style="position: relative;">
              <img
                src="${release.coverArtUrl || '/logo.webp'}"
                alt="${release.releaseName}"
                style="width: 100%; aspect-ratio: 1/1; object-fit: cover; display: block;"
                loading="lazy"
                onerror="this.src='/logo.webp'"
              />
              ${matchLabel ? `<span style="position: absolute; top: 8px; left: 8px; background: #dc2626; color: white; font-size: 12px; padding: 2px 8px; border-radius: 4px; font-weight: 600;">${matchLabel}</span>` : ''}
            </div>
            <div style="padding: 12px;">
              <p style="font-weight: 700; color: white; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0;" title="${release.releaseName || 'Untitled'}">${release.releaseName || 'Untitled'}</p>
              <p style="color: #9ca3af; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 4px 0 0 0;" title="${release.artistName || 'Unknown Artist'}">${release.artistName || 'Unknown Artist'}</p>
              <p style="color: #ef4444; font-weight: 700; font-size: 14px; margin: 4px 0 0 0;">£${price.toFixed(2)}</p>
            </div>
          </a>
        `;
      }).join('');
    } else {
      carousel.innerHTML = '<p class="text-gray-400 text-center py-8 w-full">No recommendations available yet</p>';
    }
  } catch (error) {
    console.error('[Suggestions] Error loading:', error);
    carousel.innerHTML = '<p class="text-gray-400 text-center py-8 w-full">Could not load recommendations</p>';
  }
}

function initCarousel() {
  const carousel = document.getElementById('suggestions-carousel');
  const prevBtn = document.getElementById('carousel-prev');
  const nextBtn = document.getElementById('carousel-next');
  
  if (!carousel || !prevBtn || !nextBtn) return;
  if (prevBtn.hasAttribute('data-carousel-init')) return;
  prevBtn.setAttribute('data-carousel-init', 'true');

  prevBtn.addEventListener('click', () => {
    carousel.scrollBy({ left: -220, behavior: 'smooth' });
  });

  nextBtn.addEventListener('click', () => {
    carousel.scrollBy({ left: 220, behavior: 'smooth' });
  });
}

function initScrollToComments() {
  const scrollBtn = document.getElementById('scroll-to-comments');
  const commentsSection = document.getElementById('comments-section');
  
  if (!scrollBtn || !commentsSection) return;
  if (scrollBtn.hasAttribute('data-scroll-init')) return;
  scrollBtn.setAttribute('data-scroll-init', 'true');
  
  scrollBtn.addEventListener('click', () => {
    commentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// Cart handlers - use event delegation (already safe from duplicates)
// Track if current user is allowed to make purchases
let userCanPurchase = true;
let userTypeChecked = false;

// Check user type on page load
async function checkUserPurchasePermission() {
  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
    const { getAuth, onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    
    const firebaseConfig = window.FIREBASE_CONFIG || {
      apiKey: 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
      authDomain: "freshwax-store.firebaseapp.com",
      projectId: "freshwax-store",
      storageBucket: "freshwax-store.firebasestorage.app",
      messagingSenderId: "675435782973",
      appId: "1:675435782973:web:e8459c2ec4a5f6d683db54"
    };
    
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const response = await fetch('/api/get-user-type?uid=' + user.uid);
        const data = await response.json();
        
        // Artists who are NOT also customers cannot buy
        if (data.isArtist && !data.isCustomer) {
          userCanPurchase = false;
        }
      }
      userTypeChecked = true;
    });
  } catch (e) {
    console.error('Error checking user type:', e);
    userTypeChecked = true;
  }
}

// Initialize user type check
checkUserPurchasePermission();

// Only add cart listener if not already attached (ReleasePlate.astro may have done it)
if (!window.cartListenersAttached) {
  window.cartListenersAttached = true;

document.addEventListener('click', (e) => {
  const button = e.target.closest('.add-to-cart');
  if (!button || button.hasAttribute('disabled')) return;
  
  e.preventDefault();
  console.log('[Cart] Add to cart clicked');
  
  // Check if user is allowed to make purchases
  if (!userCanPurchase) {
    alert('Artist accounts cannot make purchases. Please create a separate customer account to buy items from the store.');
    return;
  }
  
  const releaseId = button.getAttribute('data-release-id');
  const productType = button.getAttribute('data-product-type');
  const price = parseFloat(button.getAttribute('data-price') || '0');
  const title = button.getAttribute('data-title');
  const artist = button.getAttribute('data-artist');
  const artistId = button.getAttribute('data-artist-id');
  const artwork = button.getAttribute('data-artwork');

  console.log('[Cart] Item data:', { releaseId, productType, price, title, artist, artistId, artwork });

  // Use local cart functions
  const added = addItemToCart({
    id: releaseId,
    type: productType,
    name: artist + ' - ' + title,
    title: title,
    artist: artist,
    artistId: artistId,
    price: price,
    image: artwork
  });
  
  if (!added) {
    // User not logged in - addItemToCart redirects to login
    return;
  }
  
  const originalHTML = button.innerHTML;
  button.innerHTML = '<span>✓ Added!</span>';
  button.classList.add('bg-green-600');
  
  setTimeout(() => {
    button.innerHTML = originalHTML;
    button.classList.remove('bg-green-600');
  }, 1500);
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('.buy-track');
  if (!button) return;
  
  e.preventDefault();
  
  // Check if user is allowed to make purchases
  if (!userCanPurchase) {
    alert('Artist accounts cannot make purchases. Please create a separate customer account to buy items from the store.');
    return;
  }
  
  const trackId = button.getAttribute('data-track-id');
  const trackTitle = button.getAttribute('data-track-title');
  const trackPrice = parseFloat(button.getAttribute('data-track-price') || '0');
  const releaseId = button.getAttribute('data-release-id');
  const artist = button.getAttribute('data-artist');
  const artistId = button.getAttribute('data-artist-id');
  const artwork = button.getAttribute('data-artwork');

  // Check if full release already in cart
  if (hasFullReleaseInCart(releaseId)) {
    alert('You already have the full release in your cart!');
    return;
  }

  // Check if track already in cart
  if (hasTrackInCart(releaseId, trackId)) {
    alert('This track is already in your cart!');
    return;
  }

  const added = addItemToCart({
    id: releaseId,
    trackId: trackId,
    type: 'track',
    name: artist + ' - ' + trackTitle,
    title: trackTitle,
    artist: artist,
    artistId: artistId,
    price: trackPrice,
    image: artwork
  });
  
  if (!added) {
    return;
  }
  
  const originalHTML = button.innerHTML;
  button.innerHTML = '✓';
  button.classList.add('bg-green-600');
  
  setTimeout(() => {
    button.innerHTML = originalHTML;
    button.classList.remove('bg-green-600');
  }, 1500);
});
} // end cartListenersAttached guard

// ========== WISHLIST SYSTEM ==========
function getUserId() {
  const match = document.cookie.match(/(?:^|; )userId=([^;]*)/);
  return match ? match[1] : null;
}

function initWishlist() {
  const wishlistBtn = document.getElementById('wishlistBtn');
  if (!wishlistBtn || wishlistBtn.hasAttribute('data-wishlist-init')) return;
  wishlistBtn.setAttribute('data-wishlist-init', 'true');

  const userId = getUserId();

  // Check initial wishlist state
  if (userId) {
    const releaseId = wishlistBtn.getAttribute('data-release-id');
    fetch(`/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, releaseId, action: 'check' })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success && data.inWishlist) {
        setWishlistState(wishlistBtn, true);
      }
    })
    .catch(err => console.log('[Wishlist] Check error:', err));
  }

  // Handle click
  wishlistBtn.addEventListener('click', async () => {
    const userId = getUserId();
    const releaseId = wishlistBtn.getAttribute('data-release-id');

    if (!userId) {
      showToast('Please log in to add items to your wishlist');
      return;
    }

    // Disable button during request
    wishlistBtn.style.opacity = '0.5';
    wishlistBtn.style.pointerEvents = 'none';

    try {
      const response = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, releaseId, action: 'toggle' })
      });

      const data = await response.json();

      wishlistBtn.style.opacity = '1';
      wishlistBtn.style.pointerEvents = 'auto';

      if (data.success) {
        setWishlistState(wishlistBtn, data.inWishlist);
        showToast(data.inWishlist ? 'Added to wishlist!' : 'Removed from wishlist');
      } else {
        showToast('Failed to update wishlist');
      }
    } catch (err) {
      wishlistBtn.style.opacity = '1';
      wishlistBtn.style.pointerEvents = 'auto';
      console.error('[Wishlist] Error:', err);
      showToast('Failed to update wishlist');
    }
  });
}

function setWishlistState(btn, inWishlist) {
  const icon = btn.querySelector('.wishlist-icon');
  if (icon) {
    if (inWishlist) {
      icon.setAttribute('fill', 'currentColor');
      btn.classList.add('bg-red-600', 'border-red-600');
      btn.classList.remove('bg-gray-700', 'border-gray-500');
      btn.setAttribute('title', 'Remove from wishlist');
    } else {
      icon.setAttribute('fill', 'none');
      btn.classList.remove('bg-red-600', 'border-red-600');
      btn.classList.add('bg-gray-700', 'border-gray-500');
      btn.setAttribute('title', 'Add to wishlist');
    }
  }
}

// Initialize when DOM is ready
function initializeApp() {
  console.log('[App] Initializing item page...');
  initPlayer();
  initRatings();
  // initComments(); // Handled by inline script in item/[id].astro
  initShare();
  initBio();
  initWishlist();
  loadSuggestions();
  initCarousel();
  initScrollToComments();
  console.log('[App] Item page initialized');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

// Astro page transitions
document.addEventListener('astro:page-load', initializeApp);