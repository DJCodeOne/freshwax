/**
 * dj-lobby/eligibility.js — Eligibility check, bypass request, quick access code
 * Extracted from dj-lobby.astro inline JS.
 */

var ctx = null;
var currentBypassStatus = null;
var bypassPollInterval = null;

export function getBypassPollInterval() { return bypassPollInterval; }

export function init(sharedCtx) {
  ctx = sharedCtx;
}

export function showNotEligible(eligibility) {
  var escapeHtml = ctx.escapeHtml;
  document.getElementById('authGate').classList.add('hidden');
  document.getElementById('accessDenied').classList.add('hidden');
  document.getElementById('notEligible').classList.remove('hidden');

  var icon = document.querySelector('.not-eligible-icon');
  var title = document.querySelector('.not-eligible-content h1');
  var requirements = document.querySelector('.eligibility-requirements');
  var actions = document.querySelector('.eligibility-actions');
  var whySection = document.querySelector('.eligibility-why');

  if (!icon || !title || !requirements || !actions || !whySection) return;

  // Handle banned status
  if (eligibility.reason === 'banned') {
    icon.textContent = '\uD83D\uDEAB';
    title.innerHTML = 'ACCESS <span class="red">SUSPENDED</span>';
    document.getElementById('eligibilityMessage').textContent = eligibility.message || 'Your account has been suspended from streaming.';
    requirements.innerHTML = '<div class="banned-notice">'
      + '<p>Your streaming privileges have been suspended.</p>'
      + (eligibility.bannedReason ? '<p class="ban-reason">Reason: ' + escapeHtml(eligibility.bannedReason) + '</p>' : '')
      + '<p class="contact-info">If you believe this is a mistake, please contact us.</p>'
      + '</div>';
    actions.innerHTML = '<a href="/contact/" class="action-btn primary">Contact Support</a>'
      + '<a href="/live/" class="action-btn secondary">Back to Live</a>';
    whySection.classList.add('hidden');
    var bypassSection = document.getElementById('bypassRequestSection');
    if (bypassSection) bypassSection.classList.add('hidden');
    return;
  }

  // Handle on-hold status
  if (eligibility.reason === 'on_hold') {
    icon.textContent = '\u23F8\uFE0F';
    title.innerHTML = 'ON <span class="red">HOLD</span>';
    document.getElementById('eligibilityMessage').textContent = eligibility.message || 'Your streaming access is temporarily on hold.';
    requirements.innerHTML = '<div class="hold-notice">'
      + '<p>Your streaming access is temporarily restricted.</p>'
      + (eligibility.holdReason ? '<p class="hold-reason">Reason: ' + escapeHtml(eligibility.holdReason) + '</p>' : '')
      + '<p class="contact-info">Please contact us if you have questions.</p>'
      + '</div>';
    actions.innerHTML = '<a href="/contact/" class="action-btn primary">Contact Support</a>'
      + '<a href="/live/" class="action-btn secondary">Back to Live</a>';
    whySection.classList.add('hidden');
    var bypassSection2 = document.getElementById('bypassRequestSection');
    if (bypassSection2) bypassSection2.classList.add('hidden');
    return;
  }

  // Default eligibility check (mixes/likes)
  icon.textContent = '\uD83C\uDFA7';
  title.innerHTML = 'ALMOST <span class="red">THERE</span>';
  document.getElementById('eligibilityMessage').textContent = eligibility.message || 'You need to build your reputation before accessing the DJ Lobby.';

  var reqMixes = document.getElementById('reqMixes');
  var reqLikes = document.getElementById('reqLikes');

  if (reqMixes && eligibility.mixCount > 0) {
    reqMixes.classList.add('met');
    reqMixes.querySelector('.req-icon').textContent = '\u2705';
  }

  if (reqLikes && eligibility.qualifyingMixes > 0) {
    reqLikes.classList.add('met');
    reqLikes.querySelector('.req-icon').textContent = '\u2705';
  }

  var bestLikes = eligibility.bestMixLikes || 0;
  var requiredLikes = eligibility.requiredLikes || 10;
  document.getElementById('bestMixLikes').textContent = bestLikes;
  var progress = Math.min(100, (bestLikes / requiredLikes) * 100);
  document.getElementById('likesProgress').style.width = progress + '%';

  whySection.classList.remove('hidden');

  checkBypassStatus(eligibility);
  startBypassPolling();
}

export async function checkBypassStatus(eligibility) {
  var userInfo = ctx.getUserInfo();
  if (!userInfo || !userInfo.uid) return;

  try {
    var bypassController = new AbortController();
    var bypassTimeout = setTimeout(function() { bypassController.abort(); }, 15000);
    var response = await fetch('/api/admin/bypass-requests/?action=status&userId=' + userInfo.uid, {
      signal: bypassController.signal
    });
    clearTimeout(bypassTimeout);
    if (!response.ok) throw new Error('Bypass status fetch failed: ' + response.status);
    var result = await response.json();

    if (result.success) {
      currentBypassStatus = Object.assign({}, result, eligibility);
      updateBypassUI(result);
    }
  } catch (error) {
    console.error('[Bypass] Error checking status:', error);
  }
}

export function updateBypassUI(status) {
  var form = document.getElementById('bypassRequestForm');
  var pending = document.getElementById('bypassPending');
  var approved = document.getElementById('bypassApproved');
  var denied = document.getElementById('bypassDenied');

  if (form) form.classList.add('hidden');
  if (pending) pending.classList.add('hidden');
  if (approved) approved.classList.add('hidden');
  if (denied) denied.classList.add('hidden');

  if (!status.hasRequest) {
    if (form) form.classList.remove('hidden');
  } else if (status.request && status.request.status === 'pending') {
    if (pending) pending.classList.remove('hidden');
  } else if (status.request && status.request.status === 'approved') {
    if (approved) approved.classList.remove('hidden');
  } else if (status.request && status.request.status === 'denied') {
    if (denied) denied.classList.remove('hidden');
    if (status.request.denialReason) {
      var reasonEl = document.getElementById('bypassDenialReason');
      if (reasonEl) reasonEl.textContent = 'Your request was not approved: ' + status.request.denialReason;
    }
  }
}

export function startBypassPolling() {
  if (bypassPollInterval) return;
  bypassPollInterval = setInterval(async function() {
    if (currentBypassStatus && currentBypassStatus.request && currentBypassStatus.request.status === 'pending') {
      await checkBypassStatus(currentBypassStatus);
      if (currentBypassStatus && currentBypassStatus.request && currentBypassStatus.request.status === 'approved') {
        stopBypassPolling();
      }
    }
  }, 60000);
}

export function stopBypassPolling() {
  if (bypassPollInterval) {
    clearInterval(bypassPollInterval);
    bypassPollInterval = null;
  }
}

export function getCurrentBypassStatus() { return currentBypassStatus; }

export function setupEligibilityEventListeners() {
  var userInfo = ctx.getUserInfo;

  // Submit bypass request
  document.getElementById('submitBypassRequest')?.addEventListener('click', async function() {
    var btn = document.getElementById('submitBypassRequest');
    var reasonEl = document.getElementById('bypassReason');
    var reason = (reasonEl && reasonEl.value) ? reasonEl.value.trim() : '';
    var info = userInfo();

    if (!info || !info.uid) {
      alert('Please sign in first');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      var submitController = new AbortController();
      var submitTimeout = setTimeout(function() { submitController.abort(); }, 15000);
      var response = await fetch('/api/admin/bypass-requests/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          userId: info.uid,
          djName: info.name || (info.email ? info.email.split('@')[0] : 'DJ'),
          email: info.email,
          reason: reason || null,
          mixCount: (currentBypassStatus ? currentBypassStatus.mixCount : 0) || 0,
          bestMixLikes: (currentBypassStatus ? currentBypassStatus.bestMixLikes : 0) || 0
        }),
        signal: submitController.signal
      });
      clearTimeout(submitTimeout);

      if (!response.ok) throw new Error('Bypass request failed: ' + response.status);
      var result = await response.json();

      if (result.success) {
        await checkBypassStatus(currentBypassStatus || {});
      } else {
        alert(result.error || 'Failed to submit request');
        btn.disabled = false;
        btn.textContent = '\uD83C\uDFAB Request Bypass Access';
      }
    } catch (error) {
      console.error('[Bypass] Submit error:', error);
      alert('Failed to submit request. Please try again.');
      btn.disabled = false;
      btn.textContent = '\uD83C\uDFAB Request Bypass Access';
    }
  });

  // Cancel bypass request
  document.getElementById('cancelBypassRequest')?.addEventListener('click', async function() {
    if (!confirm('Cancel your bypass request?')) return;

    try {
      var info = userInfo();
      var token = await window.firebaseAuth.currentUser?.getIdToken();
      var cancelController = new AbortController();
      var cancelTimeout = setTimeout(function() { cancelController.abort(); }, 15000);
      var response = await fetch('/api/admin/bypass-requests/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
        body: JSON.stringify({
          action: 'cancel',
          userId: info.uid
        }),
        signal: cancelController.signal
      });
      clearTimeout(cancelTimeout);

      if (!response.ok) throw new Error('Cancel bypass failed: ' + response.status);
      var result = await response.json();
      if (result.success) {
        await checkBypassStatus(currentBypassStatus || {});
      } else {
        alert(result.error || 'Failed to cancel request');
      }
    } catch (error) {
      console.error('[Bypass] Cancel error:', error);
    }
  });

  // Continue with bypass (after approval)
  document.getElementById('continueWithBypass')?.addEventListener('click', function() {
    location.reload();
  });

  // Resubmit after denial
  document.getElementById('resubmitBypassRequest')?.addEventListener('click', async function() {
    try {
      var info = userInfo();
      var token = await window.firebaseAuth.currentUser?.getIdToken();
      var resubmitController = new AbortController();
      var resubmitTimeout = setTimeout(function() { resubmitController.abort(); }, 15000);
      await fetch('/api/admin/bypass-requests/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
        body: JSON.stringify({
          action: 'cancel',
          userId: info.uid
        }),
        signal: resubmitController.signal
      });
      clearTimeout(resubmitTimeout);
      await checkBypassStatus(currentBypassStatus || {});
    } catch (error) {
      console.error('[Bypass] Resubmit error:', error);
    }
  });

  // Quick Access Code Redemption
  document.getElementById('redeemAccessCodeBtn')?.addEventListener('click', async function() {
    var codeInput = document.getElementById('quickAccessCodeInput');
    var btn = document.getElementById('redeemAccessCodeBtn');
    var errorEl = document.getElementById('quickAccessError');
    var successEl = document.getElementById('quickAccessSuccess');
    var btnText = btn ? btn.querySelector('.btn-text') : null;
    var btnSpinner = btn ? btn.querySelector('.btn-spinner') : null;
    var info = userInfo();

    var code = codeInput ? (codeInput.value || '').trim() : '';
    if (!code) {
      errorEl.textContent = 'Please enter an access code';
      errorEl.classList.remove('hidden');
      successEl.classList.add('hidden');
      return;
    }

    btn.disabled = true;
    if (btnText) btnText.classList.add('hidden');
    if (btnSpinner) btnSpinner.classList.remove('hidden');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    try {
      var redeemController = new AbortController();
      var redeemTimeout = setTimeout(function() { redeemController.abort(); }, 15000);
      var response = await fetch('/api/redeem-access-key/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code,
          userId: info.uid,
          userEmail: info.email,
          userName: info.name
        }),
        signal: redeemController.signal
      });
      clearTimeout(redeemTimeout);

      if (!response.ok) throw new Error('Access code failed: ' + response.status);
      var result = await response.json();

      if (result.success) {
        successEl.textContent = result.message || 'Access granted! Redirecting to lobby...';
        successEl.classList.remove('hidden');
        errorEl.classList.add('hidden');
        setTimeout(function() { window.location.reload(); }, 1500);
      } else {
        errorEl.textContent = result.error || 'Invalid access code';
        errorEl.classList.remove('hidden');
        successEl.classList.add('hidden');
        btn.disabled = false;
        if (btnText) btnText.classList.remove('hidden');
        if (btnSpinner) btnSpinner.classList.add('hidden');
      }
    } catch (error) {
      console.error('[QuickAccess] Redeem error:', error);
      errorEl.textContent = 'Failed to redeem code. Please try again.';
      errorEl.classList.remove('hidden');
      successEl.classList.add('hidden');
      btn.disabled = false;
      if (btnText) btnText.classList.remove('hidden');
      if (btnSpinner) btnSpinner.classList.add('hidden');
    }
  });

  // Enter key to submit quick access code
  document.getElementById('quickAccessCodeInput')?.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      document.getElementById('redeemAccessCodeBtn')?.click();
    }
  });

  // Toggle Twitch stream key visibility
  document.getElementById('toggleTwitchKeyVisibility')?.addEventListener('click', function() {
    var input = document.getElementById('twitchStreamKey');
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  });
}
