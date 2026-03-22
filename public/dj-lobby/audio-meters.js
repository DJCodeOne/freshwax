// public/dj-lobby/audio-meters.js
// DJ Lobby — broadcast audio panel: LUFS metering, true peak, K-weighting, stereo scope, calibration

var ctx = null;

// Module-local state
var broadcastMeterAnimationId = null;
var broadcastAudioSource = 'preview';
var lufsHistory = [];
var lufsBlockHistory = [];
var LUFS_BLOCK_SIZE = 100;
var lastLufsBlockTime = 0;
var peakHoldL = -Infinity;
var peakHoldR = -Infinity;
var peakHoldTimer = null;
var stereoCanvasCtx = null;
var broadcastMeterFrameCount = 0;
var lastBroadcastDebugTime = 0;
var lastPPMDebugTime = 0;
var ppmUpdateCount = 0;
var lastPPMValue = { L: 0, R: 0 };

// BUTT Waveform Visualizer state
var buttWaveformCtx = null;
var buttWaveformSmoothed = new Array(64).fill(0);
var buttWaveformAttack = 0.08;
var buttWaveformDecay = 0.94;

// Calibration settings
var calGainOffset = 0;
var calRefLevel = -14;
try {
  calGainOffset = parseFloat(localStorage.getItem('calGainOffset') || '0');
  calRefLevel = parseInt(localStorage.getItem('calRefLevel') || '-14');
} catch (e) {
  // localStorage may throw in Safari private browsing
}

export function init(context) {
  ctx = context;
}

export function getBroadcastAudioSource() {
  return broadcastAudioSource;
}

export function setBroadcastAudioSource(val) {
  broadcastAudioSource = val;
}

export function getBroadcastMeterAnimationId() {
  return broadcastMeterAnimationId;
}

export function initBroadcastMeters() {
  var canvas = document.getElementById('stereoCanvas');
  if (canvas) {
    stereoCanvasCtx = canvas.getContext('2d');
  }

  document.getElementById('panelMinimize')?.addEventListener('click', function() {
    var panel = document.getElementById('broadcastAudioPanel');
    var btn = document.getElementById('panelMinimize');
    if (panel?.classList.contains('minimized')) {
      panel.classList.remove('minimized');
      btn.textContent = '\u2212';
      if (!broadcastMeterAnimationId) {
        console.debug('[BroadcastMeters] Restarting meters after panel expand');
        animateBroadcastMeters();
      }
    } else {
      panel?.classList.add('minimized');
      btn.textContent = '+';
    }
  });

  document.getElementById('audioSourceToggle')?.addEventListener('click', function() {
    var state = ctx ? ctx.getAnalyserState() : {};
    var currentPreviewSource = ctx ? ctx.getCurrentPreviewSource() : 'obs';

    if (currentPreviewSource === 'butt' || currentPreviewSource === 'relay') {
      var hasLiveAnalysers = state.liveAnalyserL && state.liveAnalyserR;
      var hasIcecastAnalysers = state.icecastAnalyserL && state.icecastAnalyserR;

      if (!hasIcecastAnalysers && !hasLiveAnalysers) {
        console.debug('[AudioToggle] Cannot toggle - no analysers available');
        return;
      }

      if (broadcastAudioSource === 'preview' && !hasLiveAnalysers) {
        var liveAudio = document.getElementById('audioElement');
        if (liveAudio && !liveAudio.paused && ctx && ctx.setupAudioMeter) {
          console.debug('[AudioToggle] Setting up live analysers for relay mode');
          ctx.setupAudioMeter(liveAudio, 'LiveAudio');
        }
      }
    }
    broadcastAudioSource = broadcastAudioSource === 'preview' ? 'live' : 'preview';
    console.debug('[AudioToggle] Switched to:', broadcastAudioSource);
    var label = document.querySelector('#audioSourceToggle .source-label');
    if (label) label.textContent = broadcastAudioSource.toUpperCase();

    if (ctx && ctx.syncAudioSource) {
      ctx.syncAudioSource(broadcastAudioSource);
    }

    if (currentPreviewSource === 'relay') {
      if (ctx && ctx.updateAudioSourceIndicator) ctx.updateAudioSourceIndicator('relay', broadcastAudioSource);
    } else if (currentPreviewSource === 'butt') {
      if (ctx && ctx.updateAudioSourceIndicator) ctx.updateAudioSourceIndicator('butt', broadcastAudioSource);
    } else {
      if (ctx && ctx.updateAudioSourceIndicator) ctx.updateAudioSourceIndicator('obs', broadcastAudioSource);
    }
  });

  document.getElementById('calibrateBtn')?.addEventListener('click', function() {
    var calPanel = document.getElementById('calibrationPanel');
    calPanel?.classList.toggle('hidden');
  });

  var gainSlider = document.getElementById('calGainOffset');
  var gainValue = document.getElementById('calGainValue');
  if (gainSlider) {
    gainSlider.value = calGainOffset;
    if (gainValue) gainValue.textContent = (calGainOffset > 0 ? '+' : '') + calGainOffset + ' dB';
    gainSlider.addEventListener('input', function(e) {
      calGainOffset = parseFloat(e.target.value);
      if (gainValue) gainValue.textContent = (calGainOffset > 0 ? '+' : '') + calGainOffset + ' dB';
      try { localStorage.setItem('calGainOffset', calGainOffset.toString()); } catch (ex) {}
    });
  }

  var refSelect = document.getElementById('calRefLevel');
  if (refSelect) {
    refSelect.value = calRefLevel.toString();
    refSelect.addEventListener('change', function(e) {
      calRefLevel = parseInt(e.target.value);
      try { localStorage.setItem('calRefLevel', calRefLevel.toString()); } catch (ex) {}
      var marker = document.querySelector('.lufs-target-marker');
      if (marker) {
        var percent = ((calRefLevel + 59) / 59) * 100;
        marker.style.left = Math.max(0, Math.min(100, percent)) + '%';
        marker.title = calRefLevel + ' LUFS Target';
      }
    });
  }

  document.getElementById('calReset')?.addEventListener('click', function() {
    calGainOffset = 0;
    calRefLevel = -14;
    try { localStorage.removeItem('calGainOffset'); localStorage.removeItem('calRefLevel'); } catch (ex) {}
    if (gainSlider) gainSlider.value = 0;
    if (gainValue) gainValue.textContent = '0 dB';
    if (refSelect) refSelect.value = '-23';
  });

  document.getElementById('calClose')?.addEventListener('click', function() {
    document.getElementById('calibrationPanel')?.classList.add('hidden');
  });

  if (!broadcastMeterAnimationId) {
    animateBroadcastMeters();
  }

  peakHoldTimer = setInterval(function() {
    peakHoldL = -Infinity;
    peakHoldR = -Infinity;
  }, 2000);

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      var panel = document.getElementById('broadcastAudioPanel');
      if (panel && !panel.classList.contains('hidden') && !broadcastMeterAnimationId) {
        console.debug('[BroadcastMeters] Restarting meters after tab visible');
        animateBroadcastMeters();
      }
    }
  });
}

export function stopBroadcastMeters() {
  if (broadcastMeterAnimationId) {
    cancelAnimationFrame(broadcastMeterAnimationId);
    broadcastMeterAnimationId = null;
  }
  if (peakHoldTimer) {
    clearInterval(peakHoldTimer);
    peakHoldTimer = null;
  }
  lufsHistory = [];
  lufsBlockHistory = [];
  lastLufsBlockTime = 0;
}

export function animateBroadcastMeters() {
  try {
    var state = ctx ? ctx.getAnalyserState() : {};
    var currentPreviewSource = ctx ? ctx.getCurrentPreviewSource() : 'obs';

    if (state.icecastAudioContext && state.icecastAudioContext.state === 'suspended') {
      console.debug('[BroadcastMeters] Resuming suspended icecastAudioContext');
      state.icecastAudioContext.resume().catch(function() { /* non-critical: AudioContext resume may fail if not user-gesture */ });
    }

    broadcastMeterFrameCount++;
    var now = Date.now();
    if (now - lastBroadcastDebugTime > 5000) {
      var relayAudio = document.getElementById('relayAudio');
      var audioPlaying = relayAudio && !relayAudio.paused && relayAudio.currentTime > 0;
      var peakL = 0, peakR = 0;
      if (state.icecastAnalyserL && state.icecastAnalyserR) {
        var testDataL = new Uint8Array(state.icecastAnalyserL.frequencyBinCount);
        var testDataR = new Uint8Array(state.icecastAnalyserR.frequencyBinCount);
        state.icecastAnalyserL.getByteFrequencyData(testDataL);
        state.icecastAnalyserR.getByteFrequencyData(testDataR);
        peakL = Math.max.apply(null, testDataL);
        peakR = Math.max.apply(null, testDataR);
      }
      console.debug('[BroadcastMeters] Status:', {
        frames: broadcastMeterFrameCount,
        animationId: broadcastMeterAnimationId,
        icecastState: state.icecastAudioContext?.state,
        hasIcecastAnalysers: !!(state.icecastAnalyserL && state.icecastAnalyserR),
        currentPreviewSource: currentPreviewSource,
        broadcastAudioSource: broadcastAudioSource,
        audioPlaying: audioPlaying,
        audioCurrentTime: relayAudio?.currentTime?.toFixed(1),
        peakL: peakL,
        peakR: peakR
      });
      lastBroadcastDebugTime = now;
      broadcastMeterFrameCount = 0;
    }

    var analyserL, analyserR;
    var kWeightedL = null, kWeightedR = null;

    if ((currentPreviewSource === 'butt' || currentPreviewSource === 'relay') && broadcastAudioSource === 'preview' && state.icecastAnalyserL && state.icecastAnalyserR) {
      analyserL = state.icecastAnalyserL;
      analyserR = state.icecastAnalyserR;
      kWeightedL = state.icecastKWeightedAnalyserL;
      kWeightedR = state.icecastKWeightedAnalyserR;
    } else if ((currentPreviewSource === 'butt' || currentPreviewSource === 'relay') && broadcastAudioSource === 'live' && state.liveAnalyserL && state.liveAnalyserR) {
      analyserL = state.liveAnalyserL;
      analyserR = state.liveAnalyserR;
      kWeightedL = state.liveKWeightedAnalyserL;
      kWeightedR = state.liveKWeightedAnalyserR;
    } else if (currentPreviewSource === 'obs') {
      analyserL = broadcastAudioSource === 'preview' ? state.obsAnalyserL : state.liveAnalyserL;
      analyserR = broadcastAudioSource === 'preview' ? state.obsAnalyserR : state.liveAnalyserR;
      kWeightedL = broadcastAudioSource === 'preview' ? state.obsKWeightedAnalyserL : state.liveKWeightedAnalyserL;
      kWeightedR = broadcastAudioSource === 'preview' ? state.obsKWeightedAnalyserR : state.liveKWeightedAnalyserR;
    } else {
      analyserL = state.icecastAnalyserL;
      analyserR = state.icecastAnalyserR;
      kWeightedL = state.icecastKWeightedAnalyserL;
      kWeightedR = state.icecastKWeightedAnalyserR;
    }

    if (analyserL && analyserR) {
      var dataL = new Uint8Array(analyserL.frequencyBinCount);
      var dataR = new Uint8Array(analyserR.frequencyBinCount);
      analyserL.getByteFrequencyData(dataL);
      analyserR.getByteFrequencyData(dataR);

      var rmsL = calculateRMS(dataL);
      var rmsR = calculateRMS(dataR);

      var dbL = 20 * Math.log10(Math.max(rmsL, 0.0001)) + calGainOffset;
      var dbR = 20 * Math.log10(Math.max(rmsR, 0.0001)) + calGainOffset;

      updateTruePeakMeter('L', dbL);
      updateTruePeakMeter('R', dbR);
      updatePPMMeter('L', dbL);
      updatePPMMeter('R', dbR);
      updateVUMeter('L', rmsL);
      updateVUMeter('R', rmsR);
      updateLUFS(rmsL, rmsR, kWeightedL, kWeightedR);
      updateCorrelation(dataL, dataR);
      updateStereoScope(dataL, dataR);

      var buttPreview = document.getElementById('buttAudioPreview');
      if (buttPreview && !buttPreview.classList.contains('hidden')) {
        var buttSpectrumL, buttSpectrumR;
        if (state.icecastAnalyserL && state.icecastAnalyserR && state.icecastConnected) {
          buttSpectrumL = state.icecastAnalyserL;
          buttSpectrumR = state.icecastAnalyserR;
        } else {
          buttSpectrumL = state.obsAnalyserL;
          buttSpectrumR = state.obsAnalyserR;
        }

        if (buttSpectrumL && buttSpectrumR) {
          var buttDataL = new Uint8Array(buttSpectrumL.frequencyBinCount);
          var buttDataR = new Uint8Array(buttSpectrumR.frequencyBinCount);
          buttSpectrumL.getByteFrequencyData(buttDataL);
          buttSpectrumR.getByteFrequencyData(buttDataR);
          updateButtSpectrum(buttDataL, buttDataR);
        }
      }
    }
  } catch (err) {
    console.error('[BroadcastMeters] ERROR:', err);
  }
  broadcastMeterAnimationId = requestAnimationFrame(animateBroadcastMeters);
}

export function calculateRMS(data) {
  var sum = 0;
  for (var i = 0; i < data.length; i++) {
    var normalized = data[i] / 255;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}

function updateTruePeakMeter(channel, db) {
  var segments = document.querySelectorAll('#truePeak' + channel + ' .segment');
  var holdEl = document.getElementById('truePeakHold' + channel);
  var valEl = document.getElementById('truePeakVal' + channel);

  var normalizedLevel = Math.max(0, Math.min(1, (db + 60) / 60));
  var litCount = Math.round(normalizedLevel * 16);

  if (channel === 'L') {
    if (db > peakHoldL) peakHoldL = db;
    if (holdEl) holdEl.style.bottom = Math.max(0, (peakHoldL + 60) / 60 * 100) + '%';
  } else {
    if (db > peakHoldR) peakHoldR = db;
    if (holdEl) holdEl.style.bottom = Math.max(0, (peakHoldR + 60) / 60 * 100) + '%';
  }

  segments.forEach(function(seg, i) {
    var segIndex = 15 - i;
    if (segIndex < litCount) {
      seg.classList.add('lit');
    } else {
      seg.classList.remove('lit');
    }
  });

  if (valEl) {
    valEl.textContent = db > -60 ? db.toFixed(1) : '-\u221E';
  }
}

function updatePPMMeter(channel, db) {
  var fillEl = document.getElementById('ppmFill' + channel);
  var peakEl = document.getElementById('ppmPeak' + channel);
  var valEl = document.getElementById('ppmVal' + channel);

  var normalizedLevel = Math.max(0, Math.min(1, (db + 60) / 63));
  var percentage = normalizedLevel * 100;

  ppmUpdateCount++;
  lastPPMValue[channel] = percentage;
  var ppmNow = Date.now();
  if (ppmNow - lastPPMDebugTime > 5000 && channel === 'L') {
    console.debug('[PPM Debug]', { updates: ppmUpdateCount, fillElExists: !!fillEl, peakElExists: !!peakEl, ppmL: lastPPMValue.L?.toFixed(1), ppmR: lastPPMValue.R?.toFixed(1), dbL: db?.toFixed(1) });
    lastPPMDebugTime = ppmNow;
    ppmUpdateCount = 0;
  }

  if (fillEl) fillEl.style.height = percentage + '%';
  if (peakEl) peakEl.style.bottom = percentage + '%';
  if (valEl) valEl.textContent = db > -60 ? db.toFixed(1) : '-\u221E';
}

function updateVUMeter(channel, rms) {
  var needleEl = document.getElementById('vuNeedle' + channel);
  if (!needleEl) return;

  var vuDb = 20 * Math.log10(Math.max(rms, 0.0001)) + 6;
  var clampedVu = Math.max(-20, Math.min(3, vuDb));
  var angle = ((clampedVu + 20) / 23) * 90 - 45;
  needleEl.style.transform = 'translateX(-50%) rotate(' + angle + 'deg)';
}

function updateLUFS(rmsL, rmsR, kWeightedAnalyserL, kWeightedAnalyserR) {
  var now = performance.now();
  var msL, msR;

  if (kWeightedAnalyserL && kWeightedAnalyserR) {
    var bufferLength = kWeightedAnalyserL.fftSize;
    var dataL = new Float32Array(bufferLength);
    var dataR = new Float32Array(bufferLength);
    kWeightedAnalyserL.getFloatTimeDomainData(dataL);
    kWeightedAnalyserR.getFloatTimeDomainData(dataR);

    var sumL = 0, sumR = 0;
    for (var i = 0; i < bufferLength; i++) {
      sumL += dataL[i] * dataL[i];
      sumR += dataR[i] * dataR[i];
    }
    msL = sumL / bufferLength;
    msR = sumR / bufferLength;
  } else {
    var kWeightingFactor = 1.2;
    msL = rmsL * rmsL * kWeightingFactor;
    msR = rmsR * rmsR * kWeightingFactor;
  }

  var summedMs = msL + msR;
  var momentaryLufs = summedMs > 1e-10 ? -0.691 + 10 * Math.log10(summedMs) : -70;
  var calibratedMomentary = momentaryLufs + calGainOffset;

  if (now - lastLufsBlockTime >= LUFS_BLOCK_SIZE) {
    lufsBlockHistory.push({ ms: summedMs, time: now });
    lastLufsBlockTime = now;
    var thirtySecondsAgo = now - 30000;
    lufsBlockHistory = lufsBlockHistory.filter(function(b) { return b.time > thirtySecondsAgo; });
  }

  var fourHundredMsAgo = now - 400;
  var momentaryBlocks = lufsBlockHistory.filter(function(b) { return b.time > fourHundredMsAgo; });
  var momentaryMs = momentaryBlocks.length > 0
    ? momentaryBlocks.reduce(function(s, b) { return s + b.ms; }, 0) / momentaryBlocks.length
    : summedMs;
  var momentaryLufsDisplay = momentaryMs > 1e-10 ? -0.691 + 10 * Math.log10(momentaryMs) + calGainOffset : -70;

  var threeSecondsAgo = now - 3000;
  var shortTermBlocks = lufsBlockHistory.filter(function(b) { return b.time > threeSecondsAgo; });
  var shortTermMs = shortTermBlocks.length > 0
    ? shortTermBlocks.reduce(function(s, b) { return s + b.ms; }, 0) / shortTermBlocks.length
    : summedMs;
  var shortTermLufs = shortTermMs > 1e-10 ? -0.691 + 10 * Math.log10(shortTermMs) + calGainOffset : -70;

  var absoluteGate = Math.pow(10, (-70 + 0.691) / 10);
  var stage1Blocks = lufsBlockHistory.filter(function(b) { return b.ms > absoluteGate; });

  var integratedLufs = -70;
  if (stage1Blocks.length > 0) {
    var ungatedMs = stage1Blocks.reduce(function(s, b) { return s + b.ms; }, 0) / stage1Blocks.length;
    var ungatedLufs = -0.691 + 10 * Math.log10(ungatedMs);
    var relativeGate = Math.pow(10, (ungatedLufs - 10 + 0.691) / 10);
    var stage2Blocks = stage1Blocks.filter(function(b) { return b.ms > relativeGate; });
    if (stage2Blocks.length > 0) {
      var gatedMs = stage2Blocks.reduce(function(s, b) { return s + b.ms; }, 0) / stage2Blocks.length;
      integratedLufs = -0.691 + 10 * Math.log10(gatedMs) + calGainOffset;
    }
  }

  var sortedMs = lufsBlockHistory.map(function(b) { return b.ms; }).sort(function(a, b) { return a - b; });
  var lufsRange = 0;
  if (sortedMs.length >= 10) {
    var p10 = sortedMs[Math.floor(sortedMs.length * 0.1)];
    var p95 = sortedMs[Math.floor(sortedMs.length * 0.95)];
    if (p10 > 1e-10 && p95 > 1e-10) {
      var p10Lufs = -0.691 + 10 * Math.log10(p10);
      var p95Lufs = -0.691 + 10 * Math.log10(p95);
      lufsRange = Math.max(0, p95Lufs - p10Lufs);
    }
  }

  var intEl = document.getElementById('lufsIntegrated');
  var shortEl = document.getElementById('lufsShort');
  var momEl = document.getElementById('lufsMomentary');
  var rangeEl = document.getElementById('lufsRange');
  var barEl = document.getElementById('lufsBarFill');

  if (intEl) intEl.textContent = integratedLufs > -60 ? integratedLufs.toFixed(1) : '-\u221E';
  if (shortEl) shortEl.textContent = shortTermLufs > -60 ? shortTermLufs.toFixed(1) : '-\u221E';
  if (momEl) momEl.textContent = momentaryLufsDisplay > -60 ? momentaryLufsDisplay.toFixed(1) : '-\u221E';
  if (rangeEl) rangeEl.textContent = isFinite(lufsRange) && lufsRange < 40 ? lufsRange.toFixed(1) + ' LU' : '0.0 LU';

  if (barEl) {
    var barPercent = Math.max(0, Math.min(100, ((integratedLufs + 60) / 60) * 100));
    barEl.style.width = barPercent + '%';
  }

  if (intEl) {
    intEl.classList.remove('lufs-safe', 'lufs-warning', 'lufs-danger', 'lufs-quiet');
    if (integratedLufs > -8) {
      intEl.classList.add('lufs-danger');
    } else if (integratedLufs > -10) {
      intEl.classList.add('lufs-warning');
    } else if (integratedLufs > -18) {
      intEl.classList.add('lufs-safe');
    } else {
      intEl.classList.add('lufs-quiet');
    }
  }
}

function updateCorrelation(dataL, dataR) {
  var sumL = 0, sumR = 0, sumLR = 0, sumL2 = 0, sumR2 = 0;
  var n = Math.min(dataL.length, dataR.length);

  for (var i = 0; i < n; i++) {
    sumL += dataL[i];
    sumR += dataR[i];
    sumLR += dataL[i] * dataR[i];
    sumL2 += dataL[i] * dataL[i];
    sumR2 += dataR[i] * dataR[i];
  }

  var meanL = sumL / n;
  var meanR = sumR / n;
  var stdL = Math.sqrt(sumL2 / n - meanL * meanL);
  var stdR = Math.sqrt(sumR2 / n - meanR * meanR);
  var covariance = sumLR / n - meanL * meanR;

  var correlation = 0;
  if (stdL > 0 && stdR > 0) {
    correlation = covariance / (stdL * stdR);
  }

  var needleEl = document.getElementById('correlationNeedle');
  var fillEl = document.getElementById('correlationFill');

  if (needleEl) {
    var percent = ((correlation + 1) / 2) * 100;
    needleEl.style.left = percent + '%';
  }

  if (fillEl) {
    var fillWidth = Math.abs(correlation) * 50;
    fillEl.style.width = fillWidth + '%';
    if (correlation >= 0) {
      fillEl.style.left = '50%';
      fillEl.style.background = '#22c55e';
    } else {
      fillEl.style.left = (50 - fillWidth) + '%';
      fillEl.style.background = '#ef4444';
    }
  }
}

function updateStereoScope(dataL, dataR) {
  if (!stereoCanvasCtx) return;

  var canvas = stereoCanvasCtx.canvas;
  var w = canvas.width;
  var h = canvas.height;
  var cx = w / 2;
  var cy = h / 2;

  stereoCanvasCtx.fillStyle = 'rgba(5, 5, 5, 0.3)';
  stereoCanvasCtx.fillRect(0, 0, w, h);

  stereoCanvasCtx.strokeStyle = '#222';
  stereoCanvasCtx.lineWidth = 1;
  stereoCanvasCtx.beginPath();
  stereoCanvasCtx.moveTo(cx, 0);
  stereoCanvasCtx.lineTo(cx, h);
  stereoCanvasCtx.moveTo(0, cy);
  stereoCanvasCtx.lineTo(w, cy);
  stereoCanvasCtx.stroke();

  stereoCanvasCtx.strokeStyle = '#22c55e';
  stereoCanvasCtx.lineWidth = 1;
  stereoCanvasCtx.beginPath();

  var step = Math.max(1, Math.floor(dataL.length / 100));
  for (var i = 0; i < dataL.length; i += step) {
    var l = (dataL[i] / 255 - 0.5) * 2;
    var r = (dataR[i] / 255 - 0.5) * 2;
    var x = cx + (l - r) * (w / 3);
    var y = cy - (l + r) * (h / 3);
    if (i === 0) {
      stereoCanvasCtx.moveTo(x, y);
    } else {
      stereoCanvasCtx.lineTo(x, y);
    }
  }
  stereoCanvasCtx.stroke();

  stereoCanvasCtx.fillStyle = 'rgba(34, 197, 94, 0.5)';
  for (var j = 0; j < dataL.length; j += step * 2) {
    var l2 = (dataL[j] / 255 - 0.5) * 2;
    var r2 = (dataR[j] / 255 - 0.5) * 2;
    var x2 = cx + (l2 - r2) * (w / 3);
    var y2 = cy - (l2 + r2) * (h / 3);
    stereoCanvasCtx.beginPath();
    stereoCanvasCtx.arc(x2, y2, 2, 0, Math.PI * 2);
    stereoCanvasCtx.fill();
  }
}

function updateButtSpectrum(dataL, dataR) {
  var canvas = document.getElementById('buttWaveformCanvas');
  if (!canvas) return;

  if (!buttWaveformCtx) {
    buttWaveformCtx = canvas.getContext('2d');
  }

  var w = canvas.width;
  var h = canvas.height;
  var cx = w / 2;
  var cy = h / 2;

  buttWaveformCtx.fillStyle = 'rgba(5, 5, 5, 0.3)';
  buttWaveformCtx.fillRect(0, 0, w, h);

  var combined = new Uint8Array(dataL.length);
  for (var i = 0; i < dataL.length; i++) {
    combined[i] = Math.max(dataL[i], dataR[i]);
  }

  var numBars = 16;
  var gap = 4;
  var barWidth = (w - (numBars - 1) * gap) / numBars;
  var binCount = combined.length;

  for (var j = 0; j < numBars; j++) {
    var startBin = Math.floor((j / numBars) * binCount * 0.5);
    var endBin = Math.floor(((j + 1) / numBars) * binCount * 0.5);

    var sum = 0;
    var count = 0;
    for (var k = startBin; k <= endBin && k < binCount; k++) {
      sum += combined[k];
      count++;
    }
    var avg = count > 0 ? sum / count : 0;
    var normalized = Math.pow(avg / 255, 0.85) * 0.9;
    var targetHeight = normalized * (h / 2 - 6);

    var smoothIdx = j;
    buttWaveformSmoothed[smoothIdx] += (targetHeight - buttWaveformSmoothed[smoothIdx]) * buttWaveformAttack;
    if (buttWaveformSmoothed[smoothIdx] > targetHeight) {
      buttWaveformSmoothed[smoothIdx] *= buttWaveformDecay;
    }

    var barHeight = buttWaveformSmoothed[smoothIdx];
    var x = j * (barWidth + gap);

    var gradient = buttWaveformCtx.createLinearGradient(0, cy - barHeight, 0, cy + barHeight);
    gradient.addColorStop(0, '#dc2626');
    gradient.addColorStop(0.3, '#ea580c');
    gradient.addColorStop(0.5, '#eab308');
    gradient.addColorStop(0.7, '#ea580c');
    gradient.addColorStop(1, '#dc2626');

    buttWaveformCtx.fillStyle = gradient;
    buttWaveformCtx.beginPath();
    buttWaveformCtx.roundRect(x, cy - barHeight, barWidth, barHeight, 2);
    buttWaveformCtx.fill();
    buttWaveformCtx.beginPath();
    buttWaveformCtx.roundRect(x, cy, barWidth, barHeight, 2);
    buttWaveformCtx.fill();
  }

  buttWaveformCtx.strokeStyle = 'rgba(220, 38, 38, 0.3)';
  buttWaveformCtx.lineWidth = 1;
  buttWaveformCtx.beginPath();
  buttWaveformCtx.moveTo(0, cy);
  buttWaveformCtx.lineTo(w, cy);
  buttWaveformCtx.stroke();

  buttWaveformCtx.shadowColor = '#dc2626';
  buttWaveformCtx.shadowBlur = 10;
}
