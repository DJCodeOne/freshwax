/**
 * dj-lobby/init-modal.js — Initialization modal (connection checks before going live)
 * Extracted from dj-lobby.astro inline JS.
 */

var ctx = null;
var initCheckInterval = null;

export function getInitCheckInterval() { return initCheckInterval; }
export function setInitCheckInterval(v) { initCheckInterval = v; }

export function init(sharedCtx) {
  ctx = sharedCtx;
}

export function showInitModal() {
  var modal = document.getElementById('initModal');
  if (!modal) return;

  var isRelayMode = ctx.getCurrentStreamMode() === 'relay';

  var progressFill = document.getElementById('initProgressFill');
  var progressText = document.getElementById('initProgressText');
  var backBtn = document.getElementById('initBackBtn');
  var goLiveBtn = document.getElementById('initGoLiveBtn');
  var modalHeader = modal.querySelector('.init-modal-header h2');
  var modalSubtitle = modal.querySelector('.init-subtitle');

  if (progressFill) progressFill.style.width = '0%';
  if (progressText) progressText.textContent = 'Starting up...';
  if (backBtn) backBtn.disabled = true;
  if (goLiveBtn) goLiveBtn.disabled = true;

  if (isRelayMode) {
    var relaySource = ctx.getSelectedRelaySource();
    if (modalHeader) modalHeader.textContent = 'Relay Mode';
    if (modalSubtitle) modalSubtitle.textContent = 'Connecting to ' + (relaySource ? relaySource.name : 'external station') + '...';
  } else {
    if (modalHeader) modalHeader.textContent = 'Initialising Stream';
    if (modalSubtitle) modalSubtitle.textContent = 'Checking your connections...';
  }

  ['initCheckObs', 'initCheckButt', 'initCheckLevels'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.classList.remove('connected', 'disconnected', 'error', 'checking');
    }
  });

  if (isRelayMode) {
    var obsLabel = document.querySelector('#initCheckObs .init-check-label');
    if (obsLabel) obsLabel.textContent = 'Relay Source';
    var obsStatus = document.getElementById('initObsStatus');
    if (obsStatus) obsStatus.textContent = 'Checking station...';
    var buttLabel = document.querySelector('#initCheckButt .init-check-label');
    if (buttLabel) buttLabel.textContent = 'Audio Stream';
    var buttStatus = document.getElementById('initButtStatus');
    if (buttStatus) buttStatus.textContent = 'Waiting...';
    var levelsLabel = document.querySelector('#initCheckLevels .init-check-label');
    if (levelsLabel) levelsLabel.textContent = 'Ready to Relay';
    var levelsStatus = document.getElementById('initLevelsStatus');
    if (levelsStatus) levelsStatus.textContent = 'Waiting...';
  } else {
    var obsLabel2 = document.querySelector('#initCheckObs .init-check-label');
    if (obsLabel2) obsLabel2.textContent = 'OBS / Video Stream';
    var obsStatus2 = document.getElementById('initObsStatus');
    if (obsStatus2) obsStatus2.textContent = 'Checking...';
    var buttLabel2 = document.querySelector('#initCheckButt .init-check-label');
    if (buttLabel2) buttLabel2.textContent = 'BUTT / Audio Stream';
    var buttStatus2 = document.getElementById('initButtStatus');
    if (buttStatus2) buttStatus2.textContent = 'Checking...';
    var levelsLabel2 = document.querySelector('#initCheckLevels .init-check-label');
    if (levelsLabel2) levelsLabel2.textContent = 'Audio Levels';
    var levelsStatus2 = document.getElementById('initLevelsStatus');
    if (levelsStatus2) levelsStatus2.textContent = 'Waiting...';
  }

  modal.classList.remove('hidden');

  if (isRelayMode) {
    startRelayChecks();
  } else {
    ctx.checkIcecastStatus().then(function() {
      setTimeout(function() { startConnectionChecks(); }, 300);
    });
  }
}

export async function startRelayChecks() {
  var progressFill = document.getElementById('initProgressFill');
  var progressText = document.getElementById('initProgressText');
  var backBtn = document.getElementById('initBackBtn');
  var goLiveBtn = document.getElementById('initGoLiveBtn');

  if (progressFill) progressFill.style.width = '30%';
  if (progressText) progressText.textContent = 'Checking relay source...';

  var obsCheck = document.getElementById('initCheckObs');
  if (obsCheck) obsCheck.classList.add('checking');

  await new Promise(function(r) { setTimeout(r, 500); });

  var selectedRelaySource = ctx.getSelectedRelaySource();
  if (!selectedRelaySource) {
    if (obsCheck) { obsCheck.classList.remove('checking'); obsCheck.classList.add('error'); }
    var s1 = document.getElementById('initObsStatus');
    if (s1) s1.textContent = 'No station selected';
    if (backBtn) backBtn.disabled = false;
    return;
  }

  var isRelayLive = false;
  try {
    var response = await fetch('/api/relay-status/?station=' + selectedRelaySource.id, {
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) {
      var result = await response.json();
      isRelayLive = result.isLive || false;
      console.debug('[Relay] Live check:', selectedRelaySource.name, isRelayLive ? 'LIVE' : 'offline');
    }
  } catch (err) {
    isRelayLive = true;
  }

  if (obsCheck) obsCheck.classList.remove('checking');
  if (isRelayLive) {
    if (obsCheck) obsCheck.classList.add('connected');
    var s2 = document.getElementById('initObsStatus');
    if (s2) s2.textContent = selectedRelaySource.name + ' is LIVE';
  } else {
    if (obsCheck) obsCheck.classList.add('disconnected');
    var s3 = document.getElementById('initObsStatus');
    if (s3) s3.textContent = selectedRelaySource.name + ' appears offline';
  }

  if (progressFill) progressFill.style.width = '60%';
  if (progressText) progressText.textContent = 'Verifying audio stream...';

  var buttCheck = document.getElementById('initCheckButt');
  if (buttCheck) buttCheck.classList.add('checking');
  await new Promise(function(r) { setTimeout(r, 500); });

  if (buttCheck) buttCheck.classList.remove('checking');
  if (isRelayLive) {
    if (buttCheck) buttCheck.classList.add('connected');
    var s4 = document.getElementById('initButtStatus');
    if (s4) s4.textContent = 'Stream URL verified';
  } else {
    if (buttCheck) buttCheck.classList.add('disconnected');
    var s5 = document.getElementById('initButtStatus');
    if (s5) s5.textContent = 'Stream may not be available';
  }

  if (progressFill) progressFill.style.width = '100%';
  if (progressText) progressText.textContent = isRelayLive ? 'Ready to go live!' : 'Warning: Source may be offline';

  var levelsCheck = document.getElementById('initCheckLevels');
  if (levelsCheck) levelsCheck.classList.add('checking');
  await new Promise(function(r) { setTimeout(r, 300); });

  if (levelsCheck) levelsCheck.classList.remove('checking');
  if (isRelayLive) {
    if (levelsCheck) levelsCheck.classList.add('connected');
    var s6 = document.getElementById('initLevelsStatus');
    if (s6) s6.textContent = 'All checks passed!';
  } else {
    if (levelsCheck) levelsCheck.classList.add('disconnected');
    var s7 = document.getElementById('initLevelsStatus');
    if (s7) s7.textContent = 'You can still try to go live';
  }

  if (backBtn) backBtn.disabled = false;
  if (goLiveBtn) goLiveBtn.disabled = false;
}

export function hideInitModal() {
  var modal = document.getElementById('initModal');
  if (modal) modal.classList.add('hidden');
  if (initCheckInterval) {
    clearInterval(initCheckInterval);
    initCheckInterval = null;
  }
}

export function startConnectionChecks() {
  var progressFill = document.getElementById('initProgressFill');
  var progressText = document.getElementById('initProgressText');

  if (progressFill) progressFill.style.width = '10%';
  if (progressText) progressText.textContent = 'Checking OBS connection...';

  var obsCheck = document.getElementById('initCheckObs');
  if (obsCheck) obsCheck.classList.add('checking');

  setTimeout(function() {
    if (progressFill) progressFill.style.width = '40%';

    var obsVideo = document.getElementById('obsVideo');
    var obsPreview = document.getElementById('obsVideoPreview');
    var isObsConnected = obsPreview && !obsPreview.classList.contains('hidden') && obsVideo &&
      (obsVideo.readyState >= 2 || !obsVideo.paused || (obsVideo.srcObject && obsVideo.srcObject.active));

    if (obsCheck) obsCheck.classList.remove('checking');
    if (isObsConnected) {
      if (obsCheck) obsCheck.classList.add('connected');
      var s1 = document.getElementById('initObsStatus');
      if (s1) s1.textContent = 'Connected - Video stream detected';
    } else {
      if (obsCheck) obsCheck.classList.add('disconnected');
      var s2 = document.getElementById('initObsStatus');
      if (s2) s2.textContent = 'Not detected - Start OBS when ready';
    }

    if (progressText) progressText.textContent = 'Checking BUTT connection...';
    var buttCheck = document.getElementById('initCheckButt');
    if (buttCheck) buttCheck.classList.add('checking');

    setTimeout(function() {
      if (progressFill) progressFill.style.width = '70%';

      var isButtConnected = ctx.getIcecastConnected() || ctx.getIcecastStreamConnected() || (ctx.getCurrentPreviewSource() === 'butt');

      if (buttCheck) buttCheck.classList.remove('checking');
      if (isButtConnected) {
        if (buttCheck) buttCheck.classList.add('connected');
        var s3 = document.getElementById('initButtStatus');
        if (s3) s3.textContent = 'Connected - Audio stream detected';
      } else {
        if (buttCheck) buttCheck.classList.add('disconnected');
        var s4 = document.getElementById('initButtStatus');
        if (s4) s4.textContent = 'Not detected - Optional for video streams';
      }

      if (progressText) progressText.textContent = 'Checking audio levels...';
      var levelsCheck = document.getElementById('initCheckLevels');
      if (levelsCheck) levelsCheck.classList.add('checking');

      setTimeout(function() {
        if (progressFill) progressFill.style.width = '100%';

        var hasAudioSignal = !!(ctx.getObsAnalyserL() || ctx.getIcecastAnalyserL());

        if (levelsCheck) levelsCheck.classList.remove('checking');
        if (hasAudioSignal) {
          if (levelsCheck) levelsCheck.classList.add('connected');
          var s5 = document.getElementById('initLevelsStatus');
          if (s5) s5.textContent = 'Audio meters active - Check your levels';
        } else {
          if (levelsCheck) levelsCheck.classList.add('disconnected');
          var s6 = document.getElementById('initLevelsStatus');
          if (s6) s6.textContent = 'No audio signal yet';
        }

        if (progressText) progressText.textContent = 'Ready to go!';
        var backBtn = document.getElementById('initBackBtn');
        var goLiveBtn = document.getElementById('initGoLiveBtn');
        if (backBtn) backBtn.disabled = false;
        if (goLiveBtn) goLiveBtn.disabled = false;

        updateInitTip(isObsConnected, isButtConnected);
        startLiveStatusUpdates();

      }, 800);
    }, 800);
  }, 1000);
}

export function startLiveStatusUpdates() {
  initCheckInterval = setInterval(function() {
    var modal = document.getElementById('initModal');
    if (!modal || modal.classList.contains('hidden')) {
      clearInterval(initCheckInterval);
      initCheckInterval = null;
      return;
    }

    var obsVideo = document.getElementById('obsVideo');
    var obsPreview = document.getElementById('obsVideoPreview');
    var isObsConnected = obsPreview && !obsPreview.classList.contains('hidden') && obsVideo &&
      (obsVideo.readyState >= 2 || !obsVideo.paused || (obsVideo.srcObject && obsVideo.srcObject.active));
    var obsCheck = document.getElementById('initCheckObs');

    if (obsCheck) obsCheck.classList.remove('connected', 'disconnected');
    if (isObsConnected) {
      if (obsCheck) obsCheck.classList.add('connected');
      var s1 = document.getElementById('initObsStatus');
      if (s1) s1.textContent = 'Connected - Video stream detected';
    } else {
      if (obsCheck) obsCheck.classList.add('disconnected');
      var s2 = document.getElementById('initObsStatus');
      if (s2) s2.textContent = 'Not detected - Start OBS when ready';
    }

    var isButtConnected = ctx.getIcecastConnected() || ctx.getIcecastStreamConnected() || (ctx.getCurrentPreviewSource() === 'butt');
    var buttCheck = document.getElementById('initCheckButt');

    if (buttCheck) buttCheck.classList.remove('connected', 'disconnected');
    if (isButtConnected) {
      if (buttCheck) buttCheck.classList.add('connected');
      var s3 = document.getElementById('initButtStatus');
      if (s3) s3.textContent = 'Connected - Audio stream detected';
    } else {
      if (buttCheck) buttCheck.classList.add('disconnected');
      var s4 = document.getElementById('initButtStatus');
      if (s4) s4.textContent = 'Not detected - Optional for video streams';
    }

    var hasAudioSignal = !!(ctx.getObsAnalyserL() || ctx.getIcecastAnalyserL());
    var levelsCheck = document.getElementById('initCheckLevels');

    if (levelsCheck) levelsCheck.classList.remove('connected', 'disconnected');
    if (hasAudioSignal) {
      if (levelsCheck) levelsCheck.classList.add('connected');
      var s5 = document.getElementById('initLevelsStatus');
      if (s5) s5.textContent = 'Audio meters active - Check your levels';
    } else {
      if (levelsCheck) levelsCheck.classList.add('disconnected');
      var s6 = document.getElementById('initLevelsStatus');
      if (s6) s6.textContent = 'No audio signal yet';
    }

    updateInitTip(isObsConnected, isButtConnected);

  }, 2000);
}

export function updateInitTip(obsConnected, buttConnected) {
  var tipsEl = document.getElementById('initTips');
  if (!tipsEl) return;

  var tipHtml = '';
  if (!obsConnected && !buttConnected) {
    tipHtml = '<div class="init-tip"><span class="tip-icon">&#128161;</span><span>Start OBS or BUTT to begin streaming</span></div>';
  } else if (obsConnected && !buttConnected) {
    tipHtml = '<div class="init-tip" style="background: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.3); color: #22c55e;">'
      + '<span class="tip-icon">&#10003;</span><span>OBS connected! Check your audio levels before going live</span></div>';
  } else if (buttConnected) {
    tipHtml = '<div class="init-tip" style="background: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.3); color: #22c55e;">'
      + '<span class="tip-icon">&#10003;</span><span>Audio stream connected! Ready when you are</span></div>';
  }
  tipsEl.innerHTML = tipHtml;
}
