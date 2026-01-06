// Email verification check for interactive features
// Include this script on pages with comments, ratings, chat, etc.
// NOTE: Existing users (created before 2026-01-06) are grandfathered in

window.FreshWax = window.FreshWax || {};

// Cutoff date - users created before this date don't need email verification
const EMAIL_VERIFY_CUTOFF = new Date('2026-01-06T00:00:00Z').getTime();

// Check if user needs email verification for interactive features
window.FreshWax.checkEmailVerified = function(action) {
  return new Promise(async (resolve) => {
    // First check if user is grandfathered (existing user before verification was required)
    const grandfathered = sessionStorage.getItem('fw_email_grandfathered');
    if (grandfathered === 'true') {
      resolve(true);
      return;
    }

    // Check sessionStorage flag (set at login for new unverified users)
    if (sessionStorage.getItem('fw_email_unverified') === 'true') {
      showVerificationModal(action);
      resolve(false);
      return;
    }

    // Double-check with Firebase auth state
    try {
      const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
      const auth = getAuth();
      const user = auth.currentUser;

      if (user) {
        // Check if user was created before the cutoff date (grandfathered)
        const creationTime = user.metadata?.creationTime;
        if (creationTime) {
          const createdAt = new Date(creationTime).getTime();
          if (createdAt < EMAIL_VERIFY_CUTOFF) {
            // Existing user - grandfather them in
            sessionStorage.setItem('fw_email_grandfathered', 'true');
            sessionStorage.removeItem('fw_email_unverified');
            console.log('[FreshWax] User grandfathered - created before verification requirement');
            resolve(true);
            return;
          }
        }

        // New user - check if email is verified
        if (!user.emailVerified) {
          sessionStorage.setItem('fw_email_unverified', 'true');
          showVerificationModal(action);
          resolve(false);
          return;
        }
      }
    } catch (e) {
      console.warn('[FreshWax] Could not check Firebase auth:', e);
    }

    resolve(true);
  });
};

// Show modal prompting user to verify email
function showVerificationModal(action) {
  // Remove existing modal if any
  const existing = document.getElementById('email-verify-modal');
  if (existing) existing.remove();

  const actionText = action || 'use this feature';

  const modal = document.createElement('div');
  modal.id = 'email-verify-modal';
  modal.innerHTML = `
    <div class="evm-overlay"></div>
    <div class="evm-content">
      <div class="evm-icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="48" height="48">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      </div>
      <h3>Verify Your Email</h3>
      <p>You need to verify your email address to ${actionText}.</p>
      <p class="evm-hint">Check your inbox for the verification link, or resend it from your account settings.</p>
      <div class="evm-buttons">
        <a href="/verify-email" class="evm-btn evm-btn-primary">Verify Now</a>
        <button type="button" class="evm-btn evm-btn-secondary" onclick="this.closest('#email-verify-modal').remove()">Maybe Later</button>
      </div>
    </div>
  `;

  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    #email-verify-modal {
      position: fixed;
      inset: 0;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .evm-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(4px);
    }
    .evm-content {
      position: relative;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 16px;
      padding: 2rem;
      max-width: 400px;
      width: 100%;
      text-align: center;
      color: #fff;
      animation: evmSlideIn 0.2s ease-out;
    }
    @keyframes evmSlideIn {
      from { opacity: 0; transform: scale(0.95) translateY(-10px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .evm-icon {
      color: #dc2626;
      margin-bottom: 1rem;
    }
    .evm-content h3 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
    }
    .evm-content p {
      color: #a3a3a3;
      margin-bottom: 0.5rem;
      line-height: 1.5;
    }
    .evm-hint {
      font-size: 0.875rem;
      color: #666;
      margin-bottom: 1.5rem !important;
    }
    .evm-buttons {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .evm-btn {
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .evm-btn-primary {
      background: #dc2626;
      color: #fff;
    }
    .evm-btn-primary:hover {
      background: #b91c1c;
    }
    .evm-btn-secondary {
      background: transparent;
      color: #888;
      border: 1px solid #333;
    }
    .evm-btn-secondary:hover {
      background: #222;
      color: #fff;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(modal);

  // Close on overlay click
  modal.querySelector('.evm-overlay').addEventListener('click', () => modal.remove());
}

// Utility to wrap click handlers with verification check
window.FreshWax.requireVerified = function(element, action, callback) {
  element.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const verified = await window.FreshWax.checkEmailVerified(action);
    if (verified) {
      callback(e);
    }
  });
};

console.log('[FreshWax] Email verification check loaded');
