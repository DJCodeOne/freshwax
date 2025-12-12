// public/interaction-gate.js
// Unified interaction gating for non-logged-in users
// Include this script on any page that needs login-gated interactions

(function() {
  'use strict';
  
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g",
    authDomain: "freshwax-store.firebaseapp.com",
    projectId: "freshwax-store",
    storageBucket: "freshwax-store.firebasestorage.app",
    messagingSenderId: "675435782973",
    appId: "1:675435782973:web:e8459c2ec4a5f6d683db54"
  };
  
  // Login modal HTML
  const LOGIN_MODAL_HTML = `
    <div id="interactionLoginModal" class="interaction-login-modal hidden">
      <div class="ilm-overlay"></div>
      <div class="ilm-content">
        <button class="ilm-close" aria-label="Close">&times;</button>
        <div class="ilm-icon">🔒</div>
        <h3 class="ilm-title">Login Required</h3>
        <p class="ilm-message">You must be logged in to interact in the store.</p>
        <div class="ilm-actions">
          <a href="/login" class="ilm-btn ilm-btn-primary">Sign In</a>
          <a href="/register" class="ilm-btn ilm-btn-secondary">Create Account</a>
        </div>
        <p class="ilm-note">You can still browse and listen to music without an account.</p>
      </div>
    </div>
  `;
  
  // Modal styles
  const MODAL_STYLES = `
    .interaction-login-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .interaction-login-modal.hidden {
      display: none;
    }
    .ilm-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
    }
    .ilm-content {
      position: relative;
      background: #fff;
      padding: 2rem;
      border-radius: 12px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
      animation: ilmSlideIn 0.3s ease;
    }
    @keyframes ilmSlideIn {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .ilm-close {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      background: none;
      border: none;
      font-size: 1.5rem;
      color: #999;
      cursor: pointer;
      padding: 0.25rem;
      line-height: 1;
      transition: color 0.2s;
    }
    .ilm-close:hover {
      color: #333;
    }
    .ilm-icon {
      font-size: 3rem;
      margin-bottom: 0.75rem;
    }
    .ilm-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 1.75rem;
      color: #111;
      margin: 0 0 0.5rem 0;
    }
    .ilm-message {
      color: #555;
      margin: 0 0 1.5rem 0;
      line-height: 1.5;
    }
    .ilm-actions {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .ilm-btn {
      display: block;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s;
    }
    .ilm-btn-primary {
      background: #dc2626;
      color: #fff;
    }
    .ilm-btn-primary:hover {
      background: #b91c1c;
    }
    .ilm-btn-secondary {
      background: #f5f5f5;
      color: #333;
      border: 1px solid #ddd;
    }
    .ilm-btn-secondary:hover {
      background: #e5e5e5;
    }
    .ilm-note {
      font-size: 0.8rem;
      color: #888;
      margin: 0;
    }
  `;
  
  // State
  let currentUser = null;
  let authInitialized = false;
  let authCallbacks = [];
  
  // Initialize Firebase and auth listener
  async function initAuth() {
    if (authInitialized) return;
    
    try {
      // First, check if Header has already initialized auth
      if (window.authReady) {
        const user = await window.authReady;
        currentUser = user;
        authInitialized = true;
        authCallbacks.forEach(cb => cb(user));
        authCallbacks = [];
        updateGatedElements();
        return;
      }
      
      // Fallback: initialize our own auth if Header hasn't loaded yet
      const { initializeApp, getApps, getApp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
      const { getAuth, onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
      
      // Use existing app if available
      const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
      const auth = getAuth(app);
      
      onAuthStateChanged(auth, (user) => {
        currentUser = user;
        authInitialized = true;
        
        // Fire all pending callbacks
        authCallbacks.forEach(cb => cb(user));
        authCallbacks = [];
        
        // Update UI elements
        updateGatedElements();
      });
    } catch (error) {
      console.error('InteractionGate: Failed to initialize auth', error);
      authInitialized = true;
    }
  }
  
  // Check if user is logged in
  function isLoggedIn() {
    return currentUser !== null;
  }
  
  // Get current user
  function getCurrentUser() {
    return currentUser;
  }
  
  // Wait for auth to initialize
  function onAuthReady(callback) {
    if (authInitialized) {
      callback(currentUser);
    } else {
      authCallbacks.push(callback);
    }
  }
  
  // Show login modal
  function showLoginModal(customMessage) {
    let modal = document.getElementById('interactionLoginModal');
    
    // Create modal if it doesn't exist
    if (!modal) {
      // Add styles
      if (!document.getElementById('ilm-styles')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'ilm-styles';
        styleEl.textContent = MODAL_STYLES;
        document.head.appendChild(styleEl);
      }
      
      // Add modal HTML
      const div = document.createElement('div');
      div.innerHTML = LOGIN_MODAL_HTML;
      document.body.appendChild(div.firstElementChild);
      modal = document.getElementById('interactionLoginModal');
      
      // Add event listeners
      modal.querySelector('.ilm-overlay').addEventListener('click', hideLoginModal);
      modal.querySelector('.ilm-close').addEventListener('click', hideLoginModal);
      
      // Store return URL
      const loginBtn = modal.querySelector('.ilm-btn-primary');
      const registerBtn = modal.querySelector('.ilm-btn-secondary');
      const returnTo = encodeURIComponent(window.location.pathname);
      loginBtn.href = `/login?returnTo=${returnTo}`;
      registerBtn.href = `/register?returnTo=${returnTo}`;
    }
    
    // Update message if custom
    if (customMessage) {
      modal.querySelector('.ilm-message').textContent = customMessage;
    }
    
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  
  // Hide login modal
  function hideLoginModal() {
    const modal = document.getElementById('interactionLoginModal');
    if (modal) {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  }
  
  // Gate an interaction - returns true if user is logged in, shows modal if not
  function gateInteraction(customMessage) {
    if (isLoggedIn()) {
      return true;
    } else {
      showLoginModal(customMessage);
      return false;
    }
  }
  
  // Add click handler that gates interaction
  function gateElement(element, customMessage) {
    if (!element) return;
    
    const originalOnclick = element.onclick;
    
    element.addEventListener('click', function(e) {
      if (!isLoggedIn()) {
        e.preventDefault();
        e.stopPropagation();
        showLoginModal(customMessage);
        return false;
      }
    }, true); // Use capture to run first
  }
  
  // Auto-gate elements with data-gate-interaction attribute
  function updateGatedElements() {
    document.querySelectorAll('[data-gate-interaction]').forEach(el => {
      const message = el.dataset.gateInteraction || 'You must be logged in to interact';
      
      if (!el.dataset.gated) {
        el.dataset.gated = 'true';
        gateElement(el, message);
      }
      
      // Update visual state
      if (isLoggedIn()) {
        el.classList.remove('interaction-disabled');
      } else {
        el.classList.add('interaction-disabled');
      }
    });
    
    // Update login prompts
    document.querySelectorAll('.login-required-prompt').forEach(el => {
      el.classList.toggle('hidden', isLoggedIn());
    });
    
    document.querySelectorAll('.logged-in-content').forEach(el => {
      el.classList.toggle('hidden', !isLoggedIn());
    });
  }
  
  // Initialize on DOM ready
  function init() {
    initAuth();
    
    // Watch for dynamically added elements
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) { // Element node
            if (node.dataset && node.dataset.gateInteraction) {
              const message = node.dataset.gateInteraction;
              gateElement(node, message);
            }
            node.querySelectorAll?.('[data-gate-interaction]').forEach(el => {
              const message = el.dataset.gateInteraction;
              if (!el.dataset.gated) {
                el.dataset.gated = 'true';
                gateElement(el, message);
              }
            });
          }
        });
      });
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  }
  
  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // Also handle Astro view transitions
  document.addEventListener('astro:page-load', () => {
    updateGatedElements();
  });
  
  // Expose API globally
  window.InteractionGate = {
    isLoggedIn,
    getCurrentUser,
    onAuthReady,
    showLoginModal,
    hideLoginModal,
    gateInteraction,
    gateElement
  };
})();
