// public/item-page.js

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

// Player initialization
function initPlayer() {
  const releaseId = document.querySelector('[data-release-id]')?.getAttribute('data-release-id');
  if (!releaseId) return;

  const playButtons = document.querySelectorAll('.play-button');
  const audioElements = document.querySelectorAll('.track-audio');
  const waveformCanvases = document.querySelectorAll('.track-waveform');
  
  let currentAudio = null;
  let currentButton = null;
  let currentCanvas = null;
  
  const bars = 20;
  
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
    setTimeout(() => {
      drawWaveform(canvas, 0, false);
    }, 100);
    
    canvas.addEventListener('click', (e) => {
      const trackId = canvas.getAttribute('data-track-id');
      const audio = document.querySelector(`.track-audio[data-track-id="${trackId}"]`);
      
      if (audio && audio.duration && isFinite(audio.duration)) {
        const rect = canvas.getBoundingClientRect();
        const progress = (e.clientX - rect.left) / rect.width;
        audio.currentTime = progress * audio.duration;
      }
    });
  });
  
  playButtons.forEach(button => {
    button.addEventListener('click', () => {
      const trackId = button.getAttribute('data-track-id');
      const audio = document.querySelector(`.track-audio[data-track-id="${trackId}"]`);
      const canvas = document.querySelector(`.track-waveform[data-track-id="${trackId}"]`);
      
      console.log('[Player] Play button clicked for track:', trackId);
      console.log('[Player] Audio element:', audio);
      console.log('[Player] Canvas element:', canvas);
      
      if (!audio) {
        console.error('[Player] No audio element found');
        return;
      }
      
      const source = audio.querySelector('source');
      console.log('[Player] Audio source:', source?.src);
      
      if (!source || !source.src) {
        alert('Preview not available for this track');
        return;
      }
      
      // Toggle play/pause for same track
      if (currentAudio === audio && !audio.paused) {
        console.log('[Player] Pausing current track');
        audio.pause();
        button.querySelector('.play-icon')?.classList.remove('hidden');
        button.querySelector('.pause-icon')?.classList.add('hidden');
        
        if (window.globalAudioManager) {
          window.globalAudioManager.currentAudio = null;
          window.globalAudioManager.currentButton = null;
        }
        return;
      }
      
      // Stop all other audio
      if (window.globalAudioManager) {
        window.globalAudioManager.stopAll();
      }
      
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
      
      currentAudio = audio;
      currentButton = button;
      currentCanvas = canvas;
      
      console.log('[Player] Playing track');
      audio.play().then(() => {
        console.log('[Player] Playback started successfully');
        button.querySelector('.play-icon')?.classList.add('hidden');
        button.querySelector('.pause-icon')?.classList.remove('hidden');
      }).catch(err => {
        console.error('[Player] Play error:', err);
        alert('Could not play preview. The file may be unavailable.');
      });
      
      if (window.globalAudioManager) {
        window.globalAudioManager.play(audio, button, 'release');
      }
    });
  });
  
  audioElements.forEach(audio => {
    const trackId = audio.getAttribute('data-track-id');
    const canvas = document.querySelector(`.track-waveform[data-track-id="${trackId}"]`);
    
    audio.addEventListener('timeupdate', () => {
      if (audio === currentAudio && audio.duration && isFinite(audio.duration) && canvas) {
        const progress = audio.currentTime / audio.duration;
        drawWaveform(canvas, progress, !audio.paused);
      }
    });
    
    audio.addEventListener('ended', () => {
      console.log('[Player] Track ended:', trackId);
      const button = document.querySelector(`.play-button[data-track-id="${trackId}"]`);
      if (button) {
        button.querySelector('.play-icon')?.classList.remove('hidden');
        button.querySelector('.pause-icon')?.classList.add('hidden');
      }
      if (canvas) {
        drawWaveform(canvas, 0, false);
      }
      currentAudio = null;
      currentButton = null;
      currentCanvas = null;
    });
    
    audio.addEventListener('loadedmetadata', () => {
      console.log('[Player] Audio metadata loaded:', { trackId, duration: audio.duration });
    });
    
    audio.addEventListener('error', (e) => {
      console.error('[Player] Audio error:', { trackId, error: e });
    });
  });
}

async function initRatings() {
  const releaseId = document.querySelector('[data-release-id]')?.getAttribute('data-release-id');
  if (!releaseId) return;

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

  document.querySelectorAll('.rating-star').forEach(star => {
    star.addEventListener('click', async () => {
      const releaseId = star.getAttribute('data-release-id');
      const rating = parseInt(star.getAttribute('data-star') || '0');
      
      const auth = window.firebaseAuth;
      
      if (!auth || !auth.currentUser) {
        alert('Please log in to rate releases. You can log in as either a customer or artist.');
        window.location.href = `/customer/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      
      const user = auth.currentUser;
      
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

  console.log('[Comments] Initializing for release:', releaseId);

  const commentText = document.getElementById('comment-text');
  const commentUsername = document.getElementById('comment-username');
  const submitBtn = document.getElementById('submit-comment-btn');
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
function updateUsernameField() {
  const auth = window.firebaseAuth;
  console.log('[Comments] Checking auth state:', { 
    authExists: !!auth, 
    currentUser: auth?.currentUser,
    displayName: auth?.currentUser?.displayName,
    email: auth?.currentUser?.email
  });
  
  if (auth && auth.currentUser && commentUsername) {
    const fullName = auth.currentUser.displayName || auth.currentUser.email?.split('@')[0] || 'User';
    // Extract only the first name
    const firstName = fullName.split(' ')[0];
    console.log('[Comments] Setting username to:', firstName);
    commentUsername.value = firstName;
    // Keep the field readonly and styled as disabled
    commentUsername.classList.add('bg-gray-100', 'cursor-not-allowed');
    commentUsername.classList.remove('bg-white');
    commentUsername.setAttribute('readonly', 'true');
    commentUsername.placeholder = '';
  } else {
    // User not logged in
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

// Try to update immediately
updateUsernameField();

// Also listen for auth state changes
if (window.firebaseAuth) {
  window.firebaseAuth.onAuthStateChanged((user) => {
    console.log('[Comments] Auth state changed:', user);
    updateUsernameField();
  });
} else {
  // Wait for firebaseAuth to be available
  const checkAuth = setInterval(() => {
    if (window.firebaseAuth) {
      console.log('[Comments] Firebase auth now available');
      clearInterval(checkAuth);
      updateUsernameField();
      window.firebaseAuth.onAuthStateChanged((user) => {
        console.log('[Comments] Auth state changed:', user);
        updateUsernameField();
      });
    }
  }, 100);
  
  // Stop checking after 5 seconds
  setTimeout(() => clearInterval(checkAuth), 5000);
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
      
      const auth = window.firebaseAuth;
      
      if (!auth || !auth.currentUser) {
        alert('Please log in to comment. You can log in as either a customer or artist.');
        window.location.href = `/customer/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      
      const user = auth.currentUser;
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
          // Clear only the comment text, not the username
          if (commentText) commentText.value = '';
          if (charCount) charCount.textContent = '0';
          
          // Re-populate the username field to ensure it doesn't disappear
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
  const shareModalClose = document.getElementById('share-modal-close');
  const shareModalBackdrop = document.getElementById('share-modal-backdrop');
  const shareUrlInput = document.getElementById('share-url-input');
  const copyUrlButton = document.getElementById('copy-url-button');
  const copyFeedback = document.getElementById('copy-feedback');
  const shareModalTitle = document.getElementById('share-modal-title');
  const shareModalArtist = document.getElementById('share-modal-artist');
  
  document.querySelectorAll('.share-button').forEach(button => {
    button.addEventListener('click', () => {
      const releaseId = button.getAttribute('data-release-id');
      const title = button.getAttribute('data-title');
      const artist = button.getAttribute('data-artist');
      const url = `${window.location.origin}/item/${releaseId}`;
      
      if (shareModalTitle) shareModalTitle.textContent = title || '';
      if (shareModalArtist) shareModalArtist.textContent = artist || '';
      if (shareUrlInput) shareUrlInput.value = url;
      if (copyFeedback) copyFeedback.textContent = '';
      
      shareModal?.classList.remove('hidden');
    });
  });
  
  const closeModal = () => {
    shareModal?.classList.add('hidden');
  };
  
  shareModalClose?.addEventListener('click', closeModal);
  shareModalBackdrop?.addEventListener('click', closeModal);
  
  copyUrlButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrlInput.value);
      if (copyFeedback) {
        copyFeedback.textContent = '✓ Link copied!';
        copyFeedback.style.color = '#16a34a';
      }
      
      setTimeout(() => {
        if (copyFeedback) copyFeedback.textContent = '';
      }, 3000);
    } catch (error) {
      if (copyFeedback) {
        copyFeedback.textContent = '✗ Failed to copy';
        copyFeedback.style.color = '#dc2626';
      }
    }
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shareModal && !shareModal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

async function loadSuggestions() {
  const releaseId = document.querySelector('[data-release-id]')?.getAttribute('data-release-id');
  const carousel = document.getElementById('suggestions-carousel');
  
  if (!carousel || !releaseId) return;

  try {
    const response = await fetch('/api/get-releases');
    const data = await response.json();
    
    if (data.success && data.releases) {
      const suggestions = data.releases
        .filter((r) => r.id !== releaseId && (r.status === 'live' || r.published))
        .slice(0, 8);
      
      carousel.innerHTML = suggestions.map((release) => `
        <a href="/item/${release.id}" class="suggestion-card block bg-gray-800 rounded-lg overflow-hidden hover:bg-gray-700 transition-all border-2 border-gray-700 hover:border-red-600">
          <img 
            src="${release.coverArtUrl || '/logo.webp'}" 
            alt="${release.releaseName}"
            class="w-full aspect-square object-cover"
            onerror="this.src='/logo.webp'"
          />
          <div class="p-3">
            <p class="font-bold text-white text-sm truncate">${release.releaseName || 'Untitled'}</p>
            <p class="text-gray-400 text-xs truncate">${release.artistName || 'Unknown Artist'}</p>
            <p class="text-red-500 font-bold text-sm mt-1">£${(release.trackPrice * (release.tracks?.length || 1)).toFixed(2)}</p>
          </div>
        </a>
      `).join('');
    }
  } catch (error) {
    console.error('[Suggestions] Error loading:', error);
  }
}

function initCarousel() {
  const carousel = document.getElementById('suggestions-carousel');
  const prevBtn = document.getElementById('carousel-prev');
  const nextBtn = document.getElementById('carousel-next');
  
  if (!carousel || !prevBtn || !nextBtn) return;

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
  
  scrollBtn.addEventListener('click', () => {
    commentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('.add-to-cart');
  if (!button || button.hasAttribute('disabled')) return;
  
  e.preventDefault();
  
  const releaseId = button.getAttribute('data-release-id');
  const productType = button.getAttribute('data-product-type');
  const price = parseFloat(button.getAttribute('data-price') || '0');
  const title = button.getAttribute('data-title');
  const artist = button.getAttribute('data-artist');
  const artwork = button.getAttribute('data-artwork');
  
  let cart = JSON.parse(localStorage.getItem('cart') || '[]');
  
  if (productType === 'vinyl') {
    cart = cart.filter((item) => !(item.productId === releaseId && item.type === 'digital'));
  }
  
  const existingIndex = cart.findIndex((item) => 
    item.productId === releaseId && item.type === productType
  );
  
  if (existingIndex !== -1) {
    cart[existingIndex].quantity += 1;
  } else {
    cart.push({
      productId: releaseId,
      type: productType,
      name: `${artist} - ${title}`,
      price: price,
      image: artwork,
      quantity: 1,
      artist: artist,
      title: title
    });
  }
  
  localStorage.setItem('cart', JSON.stringify(cart));
  window.dispatchEvent(new Event('cart-updated'));
  
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
  
  const trackId = button.getAttribute('data-track-id');
  const trackTitle = button.getAttribute('data-track-title');
  const trackPrice = parseFloat(button.getAttribute('data-track-price') || '0');
  const releaseId = button.getAttribute('data-release-id');
  const artist = button.getAttribute('data-artist');
  const artwork = button.getAttribute('data-artwork');
  
  let cart = JSON.parse(localStorage.getItem('cart') || '[]');
  
  if (cart.some((item) => item.productId === releaseId && (item.type === 'digital' || item.type === 'vinyl'))) {
    alert('You already have the full release in your cart!');
    return;
  }
  
  const existingIndex = cart.findIndex((item) => 
    item.productId === releaseId && item.trackId === trackId
  );
  
  if (existingIndex !== -1) {
    alert('This track is already in your cart!');
    return;
  }
  
  cart.push({
    productId: releaseId,
    trackId: trackId,
    type: 'track',
    name: `${artist} - ${trackTitle}`,
    price: trackPrice,
    image: artwork,
    quantity: 1,
    artist: artist,
    title: trackTitle
  });
  
  localStorage.setItem('cart', JSON.stringify(cart));
  window.dispatchEvent(new Event('cart-updated'));
  
  const originalHTML = button.innerHTML;
  button.innerHTML = '✓';
  button.classList.add('bg-green-600');
  
  setTimeout(() => {
    button.innerHTML = originalHTML;
    button.classList.remove('bg-green-600');
  }, 1500);
});

// Initialize when DOM is ready
function initializeApp() {
  console.log('[App] Initializing...');
  initPlayer();
  initRatings();
  initComments();
  initShare();
  loadSuggestions();
  initCarousel();
  initScrollToComments();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}