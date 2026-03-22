/**
 * Universal modal focus trap utility.
 *
 * Automatically observes all [role="dialog"][aria-modal="true"] elements.
 * When a modal dialog becomes visible:
 *   - Stores the previously focused element
 *   - Moves focus to the first focusable element inside the dialog
 *   - Traps Tab/Shift+Tab cycling within the dialog
 *   - Adds Escape key to close (adds .hidden + display:none)
 * When a modal dialog is hidden:
 *   - Removes the focus trap
 *   - Restores focus to the previously focused element
 *
 * Skips modals that already have data-has-focus-trap="true" to avoid
 * conflicts with existing custom focus trap implementations.
 *
 * No TypeScript. No ES modules. Compatible with <script is:inline>.
 */
(function() {
  'use strict';

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var SELECTOR = '[role="dialog"][aria-modal="true"]';

  // Track state per modal
  var trapHandlers = new WeakMap();
  var escapeHandlers = new WeakMap();
  var previousFocusElements = new WeakMap();
  var observedModals = new WeakSet();

  function isModalVisible(modal) {
    if (modal.classList.contains('hidden')) return false;
    if (modal.hasAttribute('hidden')) return false;
    var style = modal.style;
    if (style.display === 'none') return false;
    // For modals using 'active' class pattern (e.g. merch, newsletter)
    // Check offsetParent for non-fixed elements
    if (modal.offsetParent === null) {
      var computed = getComputedStyle(modal);
      if (computed.position !== 'fixed' && computed.display === 'none') return false;
      // Fixed elements with display:none won't have offsetParent either
      if (computed.display === 'none') return false;
    }
    return true;
  }

  function getVisibleFocusable(modal) {
    var els = modal.querySelectorAll(FOCUSABLE);
    var visible = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // Skip hidden elements
      if (el.offsetParent !== null || getComputedStyle(el).position === 'fixed') {
        visible.push(el);
      }
    }
    return visible;
  }

  function addFocusTrap(modal) {
    // Don't double-trap
    if (trapHandlers.has(modal)) return;
    // Skip if already has a custom focus trap
    if (modal.getAttribute('data-has-focus-trap') === 'true') return;

    // Save previous focus
    previousFocusElements.set(modal, document.activeElement);

    // Tab trap handler
    var tabHandler = function(e) {
      if (e.key !== 'Tab') return;
      var focusable = getVisibleFocusable(modal);
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    // Escape handler — close the modal (does NOT stopPropagation so
    // existing page-level Escape handlers still run for cleanup)
    var escHandler = function(e) {
      if (e.key === 'Escape') {
        closeModal(modal);
      }
    };

    trapHandlers.set(modal, tabHandler);
    escapeHandlers.set(modal, escHandler);
    modal.addEventListener('keydown', tabHandler);
    modal.addEventListener('keydown', escHandler);

    // Move focus to first focusable element (or the modal itself)
    var focusable = getVisibleFocusable(modal);
    if (focusable.length > 0) {
      // Small delay to let the modal finish rendering/animation
      setTimeout(function() {
        focusable[0].focus();
      }, 50);
    } else {
      // If no focusable elements, make the modal itself focusable
      if (!modal.hasAttribute('tabindex')) {
        modal.setAttribute('tabindex', '-1');
      }
      modal.focus();
    }
  }

  function closeModal(modal) {
    // Try clicking the modal's own close button first (triggers proper cleanup)
    var closeBtn = modal.querySelector('.modal-close, [data-action="close-modal"], button[aria-label="Close"]');
    if (closeBtn) {
      closeBtn.click();
      return;
    }
    // Fallback: handle both .active (add to show) and .hidden (remove to show) patterns
    if (modal.classList.contains('active')) {
      modal.classList.remove('active');
    } else {
      modal.classList.add('hidden');
    }
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  function removeFocusTrap(modal) {
    var tabHandler = trapHandlers.get(modal);
    if (tabHandler) {
      modal.removeEventListener('keydown', tabHandler);
      trapHandlers.delete(modal);
    }
    var escHandler = escapeHandlers.get(modal);
    if (escHandler) {
      modal.removeEventListener('keydown', escHandler);
      escapeHandlers.delete(modal);
    }
    // Restore focus
    var prev = previousFocusElements.get(modal);
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (e) { /* element may have been removed */ }
    }
    previousFocusElements.delete(modal);
  }

  function observeModal(modal) {
    if (observedModals.has(modal)) return;
    observedModals.add(modal);

    // Check initial state
    if (isModalVisible(modal)) {
      addFocusTrap(modal);
    }

    // Watch for visibility changes via class/style/attribute mutations
    var observer = new MutationObserver(function() {
      if (isModalVisible(modal)) {
        if (!trapHandlers.has(modal)) {
          addFocusTrap(modal);
        }
      } else {
        if (trapHandlers.has(modal)) {
          removeFocusTrap(modal);
        }
      }
    });

    observer.observe(modal, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden']
    });
  }

  function initAllModals() {
    var modals = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < modals.length; i++) {
      observeModal(modals[i]);
    }
  }

  // Also observe DOM for dynamically added modals
  function watchForNewModals() {
    var bodyObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(SELECTOR)) {
            observeModal(node);
          }
          if (node.querySelectorAll) {
            var inner = node.querySelectorAll(SELECTOR);
            for (var k = 0; k < inner.length; k++) {
              observeModal(inner[k]);
            }
          }
        }
      }
    });
    if (document.body) {
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      initAllModals();
      watchForNewModals();
    });
  } else {
    initAllModals();
    watchForNewModals();
  }

  // Re-init on Astro View Transitions
  document.addEventListener('astro:page-load', function() {
    initAllModals();
  });
})();
