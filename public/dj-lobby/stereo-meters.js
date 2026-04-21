/**
 * dj-lobby/stereo-meters.js — Stereo LED meters, audio meter setup, audio source toggle
 * Extracted from dj-lobby.astro inline JS (setupEventListeners inner block).
 */

var ctx = null;

// Audio contexts and analysers
var obsAudioContext = null;
var liveAudioContext = null;
var obsMeterAnimationId = null;

// Store previous levels for smoothing
var meterLevels = new Map();

// Audio source toggle
var activeAudioSource = 'preview'; // 'preview' or 'live'

export function getObsAudioContext() { return obsAudioContext; }
export function resetObsAudioContext() { if (obsAudioContext) { try { obsAudioContext.close(); } catch(e) {} obsAudioContext = null; } }
export function resumeObsAudioContext() { if (obsAudioContext && obsAudioContext.state === 'suspended') { obsAudioContext.resume(); } }
export function getLiveAudioContext() { return liveAudioContext; }
export function getObsMeterAnimationId() { return obsMeterAnimationId; }
export function setObsMeterAnimationId(v) { obsMeterAnimationId = v; }
export function getActiveAudioSource() { return activeAudioSource; }
export function setActiveAudioSource(v) { activeAudioSource = v; }

export function init(sharedCtx) {
  ctx = sharedCtx;
}

export function setupAudioMeter(videoElement, prefix) {
  try {
    var audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var source = audioContext.createMediaElementSource(videoElement);
    var splitter = audioContext.createChannelSplitter(2);

    var analyserL = audioContext.createAnalyser();
    var analyserR = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR.fftSize = 256;
    analyserL.smoothingTimeConstant = 0.5;
    analyserR.smoothingTimeConstant = 0.5;

    var kWeightedAnalyserL = audioContext.createAnalyser();
    var kWeightedAnalyserR = audioContext.createAnalyser();
    kWeightedAnalyserL.fftSize = 2048;
    kWeightedAnalyserR.fftSize = 2048;
    kWeightedAnalyserL.smoothingTimeConstant = 0;
    kWeightedAnalyserR.smoothingTimeConstant = 0;

    var highShelfL = audioContext.createBiquadFilter();
    var highShelfR = audioContext.createBiquadFilter();
    highShelfL.type = 'highshelf';
    highShelfR.type = 'highshelf';
    highShelfL.frequency.value = 1681.97;
    highShelfR.frequency.value = 1681.97;
    highShelfL.gain.value = 4;
    highShelfR.gain.value = 4;

    var highPassL = audioContext.createBiquadFilter();
    var highPassR = audioContext.createBiquadFilter();
    highPassL.type = 'highpass';
    highPassR.type = 'highpass';
    highPassL.frequency.value = 38.14;
    highPassR.frequency.value = 38.14;
    highPassL.Q.value = 0.5;
    highPassR.Q.value = 0.5;

    var upmixNode = audioContext.createGain();
    upmixNode.channelCount = 2;
    upmixNode.channelCountMode = 'explicit';
    upmixNode.channelInterpretation = 'speakers';
    source.connect(upmixNode);
    upmixNode.connect(splitter);

    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    splitter.connect(highShelfL, 0);
    splitter.connect(highShelfR, 1);
    highShelfL.connect(highPassL);
    highShelfR.connect(highPassR);
    highPassL.connect(kWeightedAnalyserL);
    highPassR.connect(kWeightedAnalyserR);

    var limiter = audioContext.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    source.connect(limiter);
    limiter.connect(audioContext.destination);

    if (prefix === 'OBS') {
      ctx.setObsKWeightedAnalysers(kWeightedAnalyserL, kWeightedAnalyserR);
    } else if (prefix === 'Live') {
      ctx.setLiveKWeightedAnalysers(kWeightedAnalyserL, kWeightedAnalyserR);
    }

    return { audioContext: audioContext, analyserL: analyserL, analyserR: analyserR, kWeightedAnalyserL: kWeightedAnalyserL, kWeightedAnalyserR: kWeightedAnalyserR };
  } catch (e) {
    console.error('[' + prefix + '] Audio meter setup error:', e);
    return null;
  }
}

export function updateLedMeter(analyser, ledRowEl, isLeftChannel) {
  if (!analyser || !ledRowEl) return 0;

  var dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);

  var sum = 0;
  for (var i = 0; i < dataArray.length; i++) {
    sum += dataArray[i] * dataArray[i];
  }
  var rms = Math.sqrt(sum / dataArray.length);
  var level = Math.min(100, (rms / 220) * 100);

  var meterId = ledRowEl.id;
  var prevLevel = meterLevels.get(meterId) || 0;

  if (level > prevLevel) {
    // fast attack
  } else {
    level = prevLevel * 0.85 + level * 0.15;
  }

  meterLevels.set(meterId, level);

  var leds = ledRowEl.querySelectorAll('.led');
  var numLeds = leds.length;
  var ledsToLight = Math.round((level / 100) * numLeds);

  leds.forEach(function(led, index) {
    var shouldLight;
    if (isLeftChannel) {
      shouldLight = index >= (numLeds - ledsToLight);
    } else {
      shouldLight = index < ledsToLight;
    }
    if (shouldLight) {
      led.classList.add('lit');
    } else {
      led.classList.remove('lit');
    }
  });

  return level;
}

export function animateObsMeters() {
  var currentPreviewSource = ctx.getCurrentPreviewSource();
  var analyserState = ctx.getAnalyserState();
  var analyserL, analyserR;

  if ((currentPreviewSource === 'butt' || currentPreviewSource === 'relay') && analyserState.icecastAnalyserL && analyserState.icecastAnalyserR) {
    analyserL = analyserState.icecastAnalyserL;
    analyserR = analyserState.icecastAnalyserR;
  } else if (analyserState.obsAnalyserL && analyserState.obsAnalyserR) {
    analyserL = analyserState.obsAnalyserL;
    analyserR = analyserState.obsAnalyserR;
  }

  if (analyserL && analyserR) {
    updateLedMeter(analyserL, document.getElementById('obsLeftLeds'), true);
    updateLedMeter(analyserR, document.getElementById('obsRightLeds'), false);
  }
  obsMeterAnimationId = requestAnimationFrame(animateObsMeters);
}

export function animateLiveMeters() {
  var currentPreviewSource = ctx.getCurrentPreviewSource();
  var analyserState = ctx.getAnalyserState();
  var analyserL, analyserR;

  if (analyserState.liveAnalyserL && analyserState.liveAnalyserR) {
    analyserL = analyserState.liveAnalyserL;
    analyserR = analyserState.liveAnalyserR;
  } else if ((currentPreviewSource === 'butt' || currentPreviewSource === 'relay') && analyserState.icecastAnalyserL && analyserState.icecastAnalyserR) {
    analyserL = analyserState.icecastAnalyserL;
    analyserR = analyserState.icecastAnalyserR;
  }

  if (analyserL && analyserR) {
    updateLedMeter(analyserL, document.getElementById('liveLeftLeds'), true);
    updateLedMeter(analyserR, document.getElementById('liveRightLeds'), false);
  }
  ctx.setLiveMeterAnimationId(requestAnimationFrame(animateLiveMeters));
}

export function updateAudioSourceUI() {
  var leftArrow = document.querySelector('.toggle-arrow.left-arrow');
  var rightArrow = document.querySelector('.toggle-arrow.right-arrow');
  var obsControls = document.getElementById('obsControls');
  var liveControls = document.getElementById('liveControls');
  var obsVid = document.getElementById('obsVideo');
  var liveVid = document.getElementById('hlsVideo');
  var liveAudio = document.getElementById('audioElement');
  var relayAudio = document.getElementById('relayAudio');
  var icecastGainNode = ctx.getIcecastGainNode();

  if (activeAudioSource === 'preview') {
    if (leftArrow) leftArrow.classList.add('active');
    if (rightArrow) rightArrow.classList.remove('active');
    if (obsControls) obsControls.classList.remove('dimmed');
    if (liveControls) liveControls.classList.add('dimmed');
    if (obsVid) obsVid.muted = false;
    if (relayAudio) relayAudio.muted = false;
    if (icecastGainNode) {
      icecastGainNode.gain.value = 1;
    }
    if (liveVid) liveVid.muted = true;
    if (liveAudio) liveAudio.muted = true;
  } else {
    if (leftArrow) leftArrow.classList.remove('active');
    if (rightArrow) rightArrow.classList.add('active');
    if (obsControls) obsControls.classList.add('dimmed');
    if (liveControls) liveControls.classList.remove('dimmed');
    if (obsVid) obsVid.muted = true;
    if (relayAudio) relayAudio.muted = true;
    if (icecastGainNode) {
      icecastGainNode.gain.value = 0;
    }
    if (liveVid) liveVid.muted = false;
    if (liveAudio) liveAudio.muted = false;
  }
}

export function setupStereoMeters() {
  var obsVid = document.getElementById('obsVideo');
  var liveVid = document.getElementById('hlsVideo');
  var audioEl = document.getElementById('audioElement');

  // Expose globally for relay and Icecast code
  window.startPreviewMeterAnimation = function() {
    if (!obsMeterAnimationId) {
      animateObsMeters();
      }
  };

  window.forceStartPreviewMeters = function() {
    if (obsMeterAnimationId) {
      cancelAnimationFrame(obsMeterAnimationId);
      obsMeterAnimationId = null;
    }
    animateObsMeters();
  };

  window.forceStartLiveMeters = function() {
    var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
    if (liveMeterAnimationId) {
      cancelAnimationFrame(liveMeterAnimationId);
      ctx.setLiveMeterAnimationId(null);
    }
    animateLiveMeters();
  };

  // OBS video play/pause handlers
  if (obsVid) {
    obsVid.addEventListener('play', function() {
      if (!obsAudioContext) {
        var result = setupAudioMeter(obsVid, 'OBS');
        if (result) {
          obsAudioContext = result.audioContext;
          ctx.setObsAnalysers(result.analyserL, result.analyserR);
        }
      }
      if (obsAudioContext && obsAudioContext.state === 'suspended') {
        obsAudioContext.resume();
      }
      if (!obsMeterAnimationId) animateObsMeters();
      var panel = document.getElementById('broadcastAudioPanel');
      if (panel && !panel.classList.contains('hidden') && !ctx.getBroadcastMeterAnimationId()) {
        ctx.initBroadcastMeters();
      }
    });
    obsVid.addEventListener('pause', function() {
      if (obsMeterAnimationId) {
        cancelAnimationFrame(obsMeterAnimationId);
        obsMeterAnimationId = null;
      }
      document.querySelectorAll('#obsLeftLeds .led, #obsRightLeds .led').forEach(function(led) { led.classList.remove('lit'); });
    });
  }

  // Live video play/pause handlers
  if (liveVid) {
    liveVid.addEventListener('play', function() {
      if (!liveAudioContext) {
        var result = setupAudioMeter(liveVid, 'Live');
        if (result) {
          liveAudioContext = result.audioContext;
          ctx.setLiveAnalysers(result.analyserL, result.analyserR);
        }
      }
      if (liveAudioContext && liveAudioContext.state === 'suspended') {
        liveAudioContext.resume();
      }
      var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
      if (!liveMeterAnimationId) animateLiveMeters();
      var panel = document.getElementById('broadcastAudioPanel');
      if (panel && !panel.classList.contains('hidden') && !ctx.getBroadcastMeterAnimationId()) {
        ctx.initBroadcastMeters();
      }
    });
    liveVid.addEventListener('pause', function() {
      var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
      if (liveMeterAnimationId) {
        cancelAnimationFrame(liveMeterAnimationId);
        ctx.setLiveMeterAnimationId(null);
      }
      document.querySelectorAll('#liveLeftLeds .led, #liveRightLeds .led').forEach(function(led) { led.classList.remove('lit'); });
    });
  }

  // Audio element play/pause handlers
  if (audioEl) {
    audioEl.addEventListener('play', function() {
      if (!liveAudioContext) {
        var result = setupAudioMeter(audioEl, 'LiveAudio');
        if (result) {
          liveAudioContext = result.audioContext;
          ctx.setLiveAnalysers(result.analyserL, result.analyserR);
        }
      }
      if (liveAudioContext && liveAudioContext.state === 'suspended') {
        liveAudioContext.resume();
      }
      var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
      if (!liveMeterAnimationId) {
        animateLiveMeters();
      }
    });
    audioEl.addEventListener('pause', function() {
      var liveVideoEl = document.getElementById('hlsVideo');
      if (!liveVideoEl || liveVideoEl.paused) {
        var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
        if (liveMeterAnimationId) {
          cancelAnimationFrame(liveMeterAnimationId);
          ctx.setLiveMeterAnimationId(null);
        }
        document.querySelectorAll('#liveLeftLeds .led, #liveRightLeds .led').forEach(function(led) { led.classList.remove('lit'); });
      }
    });
  }

  // Delayed check for already-playing audio
  setTimeout(function() {
    var ae = document.getElementById('audioElement');
    if (ae && !ae.paused && !liveAudioContext) {
      var result = setupAudioMeter(ae, 'LiveAudio');
      if (result) {
        liveAudioContext = result.audioContext;
        ctx.setLiveAnalysers(result.analyserL, result.analyserR);
      }
      var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
      if (!liveMeterAnimationId) {
        animateLiveMeters();
      }
    }

    var relayAudio = document.getElementById('relayAudio');
    if (relayAudio && !relayAudio.paused && !ctx.getIcecastAudioContext()) {
      ctx.setupIcecastAnalysers(relayAudio);
      if (!obsMeterAnimationId) {
        animateObsMeters();
      }
    }
  }, 1000);

  // Audio source toggle button
  document.getElementById('audioToggleBtn')?.addEventListener('click', function() {
    activeAudioSource = activeAudioSource === 'preview' ? 'live' : 'preview';
    updateAudioSourceUI();

    ctx.setBroadcastAudioSource(activeAudioSource);
    var label = document.querySelector('#audioSourceToggle .source-label');
    if (label) label.textContent = activeAudioSource.toUpperCase();

    var currentPreviewSource = ctx.getCurrentPreviewSource();
    if (currentPreviewSource === 'obs') {
      ctx.updateAudioSourceIndicator('obs', activeAudioSource);
    } else if (currentPreviewSource === 'relay') {
      ctx.updateAudioSourceIndicator('relay', activeAudioSource);
    } else if (currentPreviewSource === 'butt') {
      ctx.updateAudioSourceIndicator('butt', activeAudioSource);
    }

    var icecastAudioContext = ctx.getIcecastAudioContext();
    if (icecastAudioContext && icecastAudioContext.state === 'suspended') {
      icecastAudioContext.resume().catch(function() {});
    }
    if (liveAudioContext && liveAudioContext.state === 'suspended') {
      liveAudioContext.resume().catch(function() {});
    }

    if ((currentPreviewSource === 'relay' || currentPreviewSource === 'butt') && activeAudioSource === 'preview') {
      var relayAudio = document.getElementById('relayAudio');
      if (relayAudio && relayAudio.paused && relayAudio.src) {
        relayAudio.play().catch(function() {});
      }
      if (relayAudio && !relayAudio.paused && !ctx.getIcecastAudioContext()) {
        ctx.setupIcecastAnalysers(relayAudio);
      }
      if (!obsMeterAnimationId) {
        animateObsMeters();
      }
      if (!ctx.getBroadcastMeterAnimationId()) {
        ctx.animateBroadcastMeters();
      }
    }

    if ((currentPreviewSource === 'butt' || currentPreviewSource === 'relay') && activeAudioSource === 'live') {
      var liveAudioEl = document.getElementById('audioElement');
      if (liveAudioEl && liveAudioEl.paused && liveAudioEl.src) {
        liveAudioEl.play().catch(function() {});
      }
      if (liveAudioEl && !liveAudioEl.paused && !liveAudioContext) {
        var result = setupAudioMeter(liveAudioEl, 'LiveAudio');
        if (result) {
          liveAudioContext = result.audioContext;
          ctx.setLiveAnalysers(result.analyserL, result.analyserR);
        }
      }
      var liveMeterAnimationId = ctx.getLiveMeterAnimationId();
      if (!liveMeterAnimationId) {
        animateLiveMeters();
      }
      if (!obsMeterAnimationId) {
        animateObsMeters();
      }
      if (!ctx.getBroadcastMeterAnimationId()) {
        ctx.animateBroadcastMeters();
      }
    }

    var relayEl = document.getElementById('relayAudio');
    var liveEl = document.getElementById('audioElement');
  });

  // Initialize audio source state
  updateAudioSourceUI();

  // Auto-start preview LED meters on page load
  if (!obsMeterAnimationId) {
    animateObsMeters();
  }
}
