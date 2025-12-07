// public/report-system.js
// Universal report button and modal system for Fresh Wax

(function() {
  'use strict';

  // Category labels
  const CATEGORIES = {
    inappropriate_content: 'Inappropriate Content',
    harassment: 'Harassment or Bullying',
    spam: 'Spam',
    copyright: 'Copyright Violation',
    hate_speech: 'Hate Speech',
    impersonation: 'Impersonation',
    other: 'Other'
  };

  // Type labels
  const TYPES = {
    stream: 'Live Stream',
    artist: 'Artist',
    dj: 'DJ',
    user: 'User',
    release: 'Release',
    mix: 'Mix',
    comment: 'Comment',
    chat: 'Chat Message',
    other: 'Other'
  };

  // Inject modal HTML and CSS
  function injectReportModal() {
    if (document.getElementById('report-modal')) return;

    const css = `
      .report-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(4px);
        z-index: 10000;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 1rem;
      }
      .report-modal-overlay.active {
        display: flex;
      }
      .report-modal {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid rgba(255, 107, 53, 0.3);
        border-radius: 12px;
        max-width: 500px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }
      .report-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1.25rem 1.5rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .report-modal-header h3 {
        margin: 0;
        color: #fff;
        font-size: 1.25rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .report-modal-header h3::before {
        content: '⚠️';
      }
      .report-modal-close {
        background: none;
        border: none;
        color: #888;
        font-size: 1.5rem;
        cursor: pointer;
        padding: 0.25rem;
        line-height: 1;
        transition: color 0.2s;
      }
      .report-modal-close:hover {
        color: #fff;
      }
      .report-modal-body {
        padding: 1.5rem;
      }
      .report-target-info {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1.25rem;
      }
      .report-target-label {
        font-size: 0.75rem;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 0.25rem;
      }
      .report-target-name {
        color: #fff;
        font-weight: 600;
      }
      .report-form-group {
        margin-bottom: 1.25rem;
      }
      .report-form-group label {
        display: block;
        color: #ccc;
        font-size: 0.9rem;
        margin-bottom: 0.5rem;
      }
      .report-form-group label .required {
        color: #ff6b35;
      }
      .report-form-group select,
      .report-form-group textarea,
      .report-form-group input {
        width: 100%;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        color: #fff;
        font-size: 0.95rem;
        transition: border-color 0.2s, background 0.2s;
      }
      .report-form-group select:focus,
      .report-form-group textarea:focus,
      .report-form-group input:focus {
        outline: none;
        border-color: #ff6b35;
        background: rgba(255, 255, 255, 0.1);
      }
      .report-form-group select option {
        background: #1a1a2e;
        color: #fff;
      }
      .report-form-group textarea {
        min-height: 120px;
        resize: vertical;
      }
      .report-char-count {
        text-align: right;
        font-size: 0.75rem;
        color: #666;
        margin-top: 0.25rem;
      }
      .report-modal-footer {
        display: flex;
        gap: 1rem;
        padding: 1rem 1.5rem 1.5rem;
      }
      .report-btn {
        flex: 1;
        padding: 0.875rem 1.5rem;
        border-radius: 8px;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        border: none;
      }
      .report-btn-cancel {
        background: rgba(255, 255, 255, 0.1);
        color: #ccc;
      }
      .report-btn-cancel:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
      .report-btn-submit {
        background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
        color: #fff;
      }
      .report-btn-submit:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(255, 107, 53, 0.4);
      }
      .report-btn-submit:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }
      .report-success {
        text-align: center;
        padding: 2rem 1rem;
      }
      .report-success-icon {
        font-size: 3rem;
        margin-bottom: 1rem;
      }
      .report-success h4 {
        color: #4ecdc4;
        margin: 0 0 0.5rem;
        font-size: 1.25rem;
      }
      .report-success p {
        color: #888;
        margin: 0;
      }
      .report-error {
        background: rgba(255, 82, 82, 0.15);
        border: 1px solid rgba(255, 82, 82, 0.3);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        color: #ff5252;
        font-size: 0.9rem;
        margin-bottom: 1rem;
        display: none;
      }
      .report-error.visible {
        display: block;
      }

      /* Universal Report Button Styles */
      .report-btn-trigger {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.4rem 0.75rem;
        background: rgba(255, 82, 82, 0.1);
        border: 1px solid rgba(255, 82, 82, 0.2);
        border-radius: 6px;
        color: #ff5252;
        font-size: 0.8rem;
        cursor: pointer;
        transition: all 0.2s;
      }
      .report-btn-trigger:hover {
        background: rgba(255, 82, 82, 0.2);
        border-color: rgba(255, 82, 82, 0.4);
      }
      .report-btn-trigger.report-btn-icon-only {
        padding: 0.5rem;
        border-radius: 50%;
      }
      .report-btn-trigger.report-btn-text-link {
        background: none;
        border: none;
        padding: 0;
        text-decoration: underline;
      }
    `;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.id = 'report-modal';
    modal.className = 'report-modal-overlay';
    modal.innerHTML = `
      <div class="report-modal">
        <div class="report-modal-header">
          <h3>Report Content</h3>
          <button class="report-modal-close" onclick="window.ReportSystem.close()">&times;</button>
        </div>
        <div class="report-modal-body">
          <div id="report-form-container">
            <div class="report-target-info" id="report-target-info">
              <div class="report-target-label">Reporting</div>
              <div class="report-target-name" id="report-target-display">-</div>
            </div>
            
            <div class="report-error" id="report-error"></div>
            
            <div class="report-form-group">
              <label>What type of content is this? <span class="required">*</span></label>
              <select id="report-type">
                <option value="">Select type...</option>
                ${Object.entries(TYPES).map(([val, label]) => `<option value="${val}">${label}</option>`).join('')}
              </select>
            </div>
            
            <div class="report-form-group">
              <label>What's the issue? <span class="required">*</span></label>
              <select id="report-category">
                <option value="">Select category...</option>
                ${Object.entries(CATEGORIES).map(([val, label]) => `<option value="${val}">${label}</option>`).join('')}
              </select>
            </div>
            
            <div class="report-form-group">
              <label>Describe the issue <span class="required">*</span></label>
              <textarea id="report-description" placeholder="Please provide details about the issue..." maxlength="1000"></textarea>
              <div class="report-char-count"><span id="report-char-count">0</span>/1000</div>
            </div>
            
            <div class="report-form-group">
              <label>Your email (optional, for follow-up)</label>
              <input type="email" id="report-email" placeholder="your@email.com">
            </div>
          </div>
          
          <div id="report-success-container" class="report-success" style="display: none;">
            <div class="report-success-icon">✓</div>
            <h4>Report Submitted</h4>
            <p>Thank you. Our team will review this shortly.</p>
          </div>
        </div>
        <div class="report-modal-footer" id="report-footer">
          <button class="report-btn report-btn-cancel" onclick="window.ReportSystem.close()">Cancel</button>
          <button class="report-btn report-btn-submit" id="report-submit-btn" onclick="window.ReportSystem.submit()">Submit Report</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) window.ReportSystem.close();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        window.ReportSystem.close();
      }
    });

    // Character count
    document.getElementById('report-description').addEventListener('input', (e) => {
      document.getElementById('report-char-count').textContent = e.target.value.length;
    });
  }

  // Current report context
  let currentReport = {
    type: '',
    targetId: '',
    targetName: '',
    targetUrl: ''
  };

  // Get current user info (if available)
  function getCurrentUser() {
    // Try to get from Firebase auth or stored user data
    if (window.firebase && window.firebase.auth) {
      const user = window.firebase.auth().currentUser;
      if (user) {
        return {
          id: user.uid,
          name: user.displayName || user.email,
          email: user.email
        };
      }
    }
    // Try localStorage
    try {
      const stored = localStorage.getItem('fw_user');
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return null;
  }

  // Open report modal
  function openReport(options = {}) {
    injectReportModal();
    
    currentReport = {
      type: options.type || '',
      targetId: options.targetId || '',
      targetName: options.targetName || '',
      targetUrl: options.targetUrl || window.location.href
    };

    // Reset form
    document.getElementById('report-type').value = currentReport.type;
    document.getElementById('report-category').value = '';
    document.getElementById('report-description').value = '';
    document.getElementById('report-char-count').textContent = '0';
    document.getElementById('report-error').classList.remove('visible');
    document.getElementById('report-form-container').style.display = 'block';
    document.getElementById('report-success-container').style.display = 'none';
    document.getElementById('report-footer').style.display = 'flex';
    document.getElementById('report-submit-btn').disabled = false;

    // Set target display
    const targetDisplay = currentReport.targetName || TYPES[currentReport.type] || 'Content';
    document.getElementById('report-target-display').textContent = targetDisplay;

    // Pre-fill email if user is logged in
    const user = getCurrentUser();
    if (user && user.email) {
      document.getElementById('report-email').value = user.email;
    }

    // Show modal
    document.getElementById('report-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  // Close modal
  function closeReport() {
    const modal = document.getElementById('report-modal');
    if (modal) {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  }

  // Submit report
  async function submitReport() {
    const type = document.getElementById('report-type').value;
    const category = document.getElementById('report-category').value;
    const description = document.getElementById('report-description').value;
    const email = document.getElementById('report-email').value;
    const errorEl = document.getElementById('report-error');
    const submitBtn = document.getElementById('report-submit-btn');

    // Validation
    if (!type) {
      errorEl.textContent = 'Please select a content type';
      errorEl.classList.add('visible');
      return;
    }
    if (!category) {
      errorEl.textContent = 'Please select a category';
      errorEl.classList.add('visible');
      return;
    }
    if (!description || description.length < 10) {
      errorEl.textContent = 'Please provide a description (at least 10 characters)';
      errorEl.classList.add('visible');
      return;
    }

    errorEl.classList.remove('visible');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    const user = getCurrentUser();

    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          targetId: currentReport.targetId,
          targetName: currentReport.targetName,
          targetUrl: currentReport.targetUrl,
          category,
          description,
          reporterId: user?.id || null,
          reporterName: user?.name || 'Anonymous',
          reporterEmail: email || user?.email || null
        })
      });

      const result = await response.json();

      if (result.success) {
        document.getElementById('report-form-container').style.display = 'none';
        document.getElementById('report-success-container').style.display = 'block';
        document.getElementById('report-footer').style.display = 'none';
        
        // Auto-close after 3 seconds
        setTimeout(() => closeReport(), 3000);
      } else {
        errorEl.textContent = result.error || 'Failed to submit report';
        errorEl.classList.add('visible');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
      }
    } catch (error) {
      console.error('Report submission error:', error);
      errorEl.textContent = 'Network error. Please try again.';
      errorEl.classList.add('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
    }
  }

  // Create a report button element
  function createButton(options = {}) {
    const btn = document.createElement('button');
    btn.className = 'report-btn-trigger';
    
    if (options.iconOnly) {
      btn.classList.add('report-btn-icon-only');
      btn.innerHTML = '🚩';
      btn.title = 'Report';
    } else if (options.textOnly) {
      btn.classList.add('report-btn-text-link');
      btn.textContent = options.text || 'Report';
    } else {
      btn.innerHTML = `<span>🚩</span><span>${options.text || 'Report'}</span>`;
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openReport({
        type: options.type || '',
        targetId: options.targetId || '',
        targetName: options.targetName || '',
        targetUrl: options.targetUrl || ''
      });
    });

    return btn;
  }

  // Initialize buttons from data attributes
  function initButtons() {
    document.querySelectorAll('[data-report]').forEach(el => {
      if (el.dataset.reportInitialized) return;
      el.dataset.reportInitialized = 'true';
      
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openReport({
          type: el.dataset.reportType || '',
          targetId: el.dataset.reportId || '',
          targetName: el.dataset.reportName || '',
          targetUrl: el.dataset.reportUrl || ''
        });
      });
    });
  }

  // Expose API globally
  window.ReportSystem = {
    open: openReport,
    close: closeReport,
    submit: submitReport,
    createButton: createButton,
    init: initButtons
  };

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initButtons);
  } else {
    initButtons();
  }

  // Re-init on dynamic content (for SPAs)
  const observer = new MutationObserver(() => {
    initButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
