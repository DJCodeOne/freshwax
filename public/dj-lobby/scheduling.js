// public/dj-lobby/scheduling.js
// DJ Lobby — slot booking, calendar, time validation, consecutive slot checking, subscription tier

var ctx = null;

// Module-local state
var mySlot = null;
var allDjSlots = [];
var currentStreamKey = null;
var streamKeyValidUntil = null;
var streamKeyDisplayed = false;
var currentStreamSource = 'obs';
var approvedRelayData = null;
var currentEventSession = null;

export function init(context) {
  ctx = context;
}

// Getters/setters for main script
export function getMySlot() {
  return mySlot;
}

export function setMySlot(val) {
  mySlot = val;
}

export function getAllDjSlots() {
  return allDjSlots;
}

export function getCurrentStreamKey() {
  return currentStreamKey;
}

export function setCurrentStreamKey(val) {
  currentStreamKey = val;
}


export async function loadMySlot() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  if (!currentUser) return;

  try {
    var now = new Date();
    var end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    var slotController = new AbortController();
    var slotTimeout = setTimeout(function() { slotController.abort(); }, 15000);
    var response = await fetch('/api/livestream/slots/?start=' + now.toISOString() + '&end=' + end.toISOString() + '&djId=' + currentUser.uid, {
      signal: slotController.signal
    });
    clearTimeout(slotTimeout);
    if (!response.ok) {
      console.error('Load slot error: HTTP ' + response.status);
      return;
    }
    var result = await response.json();

    if (result.success && result.slots && result.slots.length > 0) {
      var sortedSlots = result.slots.sort(function(a, b) {
        return new Date(a.startTime) - new Date(b.startTime);
      });
      mySlot = sortedSlots[0];
      checkStreamKeyAvailability();
    } else {
      mySlot = null;
      showKeyNotAvailable();
    }
  } catch (e) {
    console.error('Load slot error:', e);
  }
}

export async function loadAllSlots() {
  try {
    var now = new Date();
    var end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    var allSlotsController = new AbortController();
    var allSlotsTimeout = setTimeout(function() { allSlotsController.abort(); }, 15000);
    var response = await fetch('/api/livestream/slots/?start=' + now.toISOString() + '&end=' + end.toISOString(), {
      signal: allSlotsController.signal
    });
    clearTimeout(allSlotsTimeout);
    if (!response.ok) {
      console.error('Load all slots error: HTTP ' + response.status);
      return;
    }
    var result = await response.json();
    if (result.success && result.slots) {
      allDjSlots = result.slots.sort(function(a, b) {
        return new Date(a.startTime) - new Date(b.startTime);
      });
    }
  } catch (e) {
    console.error('Load all slots error:', e);
  }
}

export function calculateContinuousEndTime(djId, currentEndTime) {
  if (!allDjSlots || allDjSlots.length === 0) return currentEndTime;

  var endTime = new Date(currentEndTime);
  var djSlots = allDjSlots.filter(function(s) { return s.djId === djId; });

  djSlots.sort(function(a, b) {
    return new Date(a.startTime) - new Date(b.startTime);
  });

  var extended = true;
  while (extended) {
    extended = false;
    for (var i = 0; i < djSlots.length; i++) {
      var slot = djSlots[i];
      var slotStart = new Date(slot.startTime);
      var slotEnd = new Date(slot.endTime);

      var gap = Math.abs(slotStart.getTime() - endTime.getTime());
      if (gap <= 5 * 60 * 1000 && slotEnd > endTime) {
        endTime = slotEnd;
        extended = true;
        var log = ctx ? ctx.log : function() {};
        log('[Slots] Extended end time to ' + slotEnd.toLocaleTimeString() + ' for consecutive slot');
      }
    }
  }

  return endTime;
}

export function hasSameDjNextSlot(djId, currentEndTime) {
  if (!allDjSlots || allDjSlots.length === 0) return false;

  var endTime = new Date(currentEndTime);

  for (var i = 0; i < allDjSlots.length; i++) {
    var slot = allDjSlots[i];
    var slotStart = new Date(slot.startTime);
    var gap = Math.abs(slotStart.getTime() - endTime.getTime());

    if (gap <= 5 * 60 * 1000 && slot.djId === djId) {
      return true;
    }
  }
  return false;
}

export function isEventSession(djId, streamStart) {
  if (!allDjSlots || allDjSlots.length === 0) return null;

  var djSlots = allDjSlots.filter(function(s) {
    return s.djId === djId && ['scheduled', 'live', 'in_lobby'].indexOf(s.status) !== -1;
  });
  if (djSlots.length === 0) return null;

  djSlots.sort(function(a, b) {
    return new Date(a.startTime) - new Date(b.startTime);
  });

  var start = new Date(streamStart);
  var eventSlot = null;

  for (var i = 0; i < djSlots.length; i++) {
    var slot = djSlots[i];
    var slotStart = new Date(slot.startTime);
    var slotEnd = new Date(slot.endTime);

    if (start >= new Date(slotStart.getTime() - 15 * 60000) && start < slotEnd) {
      eventSlot = slot;
      break;
    }
  }

  if (!eventSlot) return null;

  var duration = eventSlot.duration ||
    (new Date(eventSlot.endTime) - new Date(eventSlot.startTime)) / 60000;

  if (duration >= 120) {
    return {
      isEvent: true,
      startTime: new Date(eventSlot.startTime),
      endTime: new Date(eventSlot.endTime),
      totalDuration: duration,
      slots: [eventSlot]
    };
  }

  var eventEnd = new Date(eventSlot.endTime);
  var eventSlots = [eventSlot];
  var totalDuration = duration;

  for (var j = 0; j < djSlots.length; j++) {
    var s = djSlots[j];
    if (s.id === eventSlot.id) continue;
    var sStart = new Date(s.startTime);
    var sEnd = new Date(s.endTime);
    var sDuration = s.duration || (sEnd - sStart) / 60000;

    var gap = Math.abs(sStart.getTime() - eventEnd.getTime());
    if (gap <= 5 * 60000 && sEnd > eventEnd) {
      eventSlots.push(s);
      eventEnd = sEnd;
      totalDuration += sDuration;
    }
  }

  if (totalDuration >= 120 || eventSlots.length >= 2) {
    return {
      isEvent: true,
      startTime: new Date(eventSlot.startTime),
      endTime: eventEnd,
      totalDuration: totalDuration,
      slots: eventSlots
    };
  }

  return null;
}

export function calculateMaxStreamEndTime(djId, streamStart, hasBookedSlot) {
  var log = ctx ? ctx.log : function() {};
  var userSubscription = ctx ? ctx.getUserSubscription() : null;
  var start = new Date(streamStart);

  var eventSession = isEventSession(djId, streamStart);
  if (eventSession && eventSession.isEvent) {
    currentEventSession = eventSession;
    log('[Stream] Event session detected: ' + eventSession.totalDuration + ' minutes total');
    return eventSession.endTime;
  }

  currentEventSession = null;

  var endOfCurrentHour = new Date(start);
  endOfCurrentHour.setMinutes(0, 0, 0);
  endOfCurrentHour.setHours(endOfCurrentHour.getHours() + 1);

  if (hasBookedSlot) {
    var continuousEnd = calculateContinuousEndTime(djId, endOfCurrentHour);
    return continuousEnd;
  }

  var isPro = userSubscription ? (userSubscription.isPro || false) : false;
  var extraHours = isPro ? 2 : 1;

  var hasNextHour = hasSameDjNextSlot(djId, endOfCurrentHour);

  if (hasNextHour) {
    var contEnd = calculateContinuousEndTime(djId, endOfCurrentHour);
    return contEnd;
  }

  var maxEnd = new Date(endOfCurrentHour);
  maxEnd.setHours(maxEnd.getHours() + extraHours);

  log('[Stream] Max end time: ' + maxEnd.toLocaleTimeString() + ' (' + (isPro ? 'Pro' : 'Free') + ' tier)');
  return maxEnd;
}

export function isInEventMode() {
  return currentEventSession && currentEventSession.isEvent;
}

export function formatDuration(totalMinutes) {
  if (totalMinutes <= 0) return '0 minutes';

  var days = Math.floor(totalMinutes / 1440);
  var hours = Math.floor((totalMinutes % 1440) / 60);
  var mins = totalMinutes % 60;

  var parts = [];
  if (days > 0) parts.push(days + ' day' + (days !== 1 ? 's' : ''));
  if (hours > 0) parts.push(hours + ' hour' + (hours !== 1 ? 's' : ''));
  if (mins > 0 || parts.length === 0) parts.push(mins + ' minute' + (mins !== 1 ? 's' : ''));

  return parts.join(', ');
}

export function showKeyNotAvailable() {
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var slotTimeDisplay = document.getElementById('slotTimeDisplay');
  var countdownEl = document.getElementById('countdownToSlot');
  var streamKeyEl = document.getElementById('myStreamKey');
  var setReadyBtn = document.getElementById('setReadyBtn');

  if (!currentStream) {
    if (slotTimeDisplay) slotTimeDisplay.textContent = 'No slot booked';
    if (countdownEl) countdownEl.textContent = 'Press I\'m Ready to go live now';

    if (streamKeyEl) {
      streamKeyEl.classList.remove('key-loading');
      streamKeyEl.classList.add('key-unavailable');
      streamKeyEl.innerHTML = '<span class="key-no-slot">Click Spawn</span>';
    }

    if (setReadyBtn) {
      setReadyBtn.disabled = false;
      setReadyBtn.classList.add('glow');
      setReadyBtn.title = 'Click to auto-book a slot and go live';
    }
  } else {
    if (slotTimeDisplay) slotTimeDisplay.textContent = 'No slot booked';
    if (countdownEl) countdownEl.textContent = 'Book a slot to go live';

    if (streamKeyEl) {
      streamKeyEl.classList.remove('key-loading');
      streamKeyEl.classList.add('key-unavailable');
      streamKeyEl.innerHTML = '<span class="key-no-slot">Book a slot first</span>';
    }

    if (setReadyBtn) {
      setReadyBtn.disabled = true;
      setReadyBtn.classList.remove('glow');
      setReadyBtn.title = 'You need to book a slot first';
    }
  }
}

export function checkStreamKeyAvailability() {
  var log = ctx ? ctx.log : function() {};
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var updateButtPassword = ctx ? ctx.updateButtPassword : function() {};
  var startObsPreviewCheck = ctx ? ctx.startObsPreviewCheck : function() {};
  var slotTimeDisplay = document.getElementById('slotTimeDisplay');
  var countdownEl = document.getElementById('countdownToSlot');
  var streamKeyEl = document.getElementById('myStreamKey');

  if (mySlot) {
    var now = new Date();
    var slotStart = new Date(mySlot.startTime);
    var slotEnd = new Date(mySlot.endTime);

    if (slotTimeDisplay) {
      slotTimeDisplay.textContent =
        'Your slot: ' + slotStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' - ' + slotEnd.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    var minsUntil = Math.ceil((slotStart - now) / 60000);
    if (countdownEl) {
      if (minsUntil > 0) {
        countdownEl.textContent = 'Starts in ' + formatDuration(minsUntil);
        countdownEl.classList.remove('slot-now');
      } else if (now < slotEnd) {
        countdownEl.textContent = 'Your slot is NOW!';
        countdownEl.classList.add('slot-now');
      } else {
        countdownEl.textContent = '';
        countdownEl.classList.remove('slot-now');
      }
    }

    if (mySlot.streamKey) {
      currentStreamKey = mySlot.streamKey;
      updateButtPassword(currentStreamKey);
      if (!streamKeyDisplayed && streamKeyEl) {
        streamKeyEl.classList.remove('key-loading', 'key-unavailable');
        streamKeyEl.classList.add('key-reveal');
        streamKeyEl.textContent = '';
        var keySpan = document.createElement('span');
        keySpan.className = 'key-text';
        keySpan.textContent = mySlot.streamKey;
        streamKeyEl.appendChild(keySpan);
        streamKeyDisplayed = true;
      }
      startObsPreviewCheck();
    } else {
      log('[checkStreamKeyAvailability] Slot found but no key, generating...');
      loadStreamKeyForGoLive();
    }

    var setReadyBtn = document.getElementById('setReadyBtn');
    if (setReadyBtn && !setReadyBtn.classList.contains('is-ready-state') && !setReadyBtn.classList.contains('is-ready')) {
      setReadyBtn.disabled = false;
      setReadyBtn.classList.add('glow');
      setReadyBtn.title = '';
    }
  } else {
    var setReadyBtn2 = document.getElementById('setReadyBtn');

    if (!currentStream) {
      if (slotTimeDisplay) slotTimeDisplay.textContent = 'No slot booked';
      if (countdownEl) countdownEl.textContent = 'Press I\'m Ready to go live now';

      if (streamKeyEl) {
        streamKeyEl.classList.remove('key-loading');
        streamKeyEl.classList.add('key-unavailable');
        streamKeyEl.innerHTML = '<span class="key-no-slot">Click Spawn</span>';
      }

      if (setReadyBtn2 && !setReadyBtn2.classList.contains('is-ready-state') && !setReadyBtn2.classList.contains('is-ready')) {
        setReadyBtn2.disabled = false;
        setReadyBtn2.classList.add('glow');
        setReadyBtn2.title = 'Click to auto-book a slot and go live';
      }
    } else {
      if (slotTimeDisplay) slotTimeDisplay.textContent = 'No slot booked';
      if (countdownEl) countdownEl.textContent = 'Book a slot to go live';

      if (streamKeyEl) {
        streamKeyEl.classList.remove('key-loading');
        streamKeyEl.classList.add('key-unavailable');
        streamKeyEl.innerHTML = '<span class="key-no-slot">Book a slot first</span>';
      }

      if (setReadyBtn2) {
        setReadyBtn2.disabled = true;
        setReadyBtn2.classList.remove('glow');
        setReadyBtn2.title = 'You need to book a slot first';
      }
    }
  }
}

export async function fetchStreamKey() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var updateButtPassword = ctx ? ctx.updateButtPassword : function() {};
  if (!currentUser || !mySlot) return;

  try {
    var token = await currentUser.getIdToken();
    var keyController = new AbortController();
    var keyTimeout = setTimeout(function() { keyController.abort(); }, 15000);
    var response = await fetch('/api/livestream/slots/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ action: 'getStreamKey', slotId: mySlot.id, djId: currentUser.uid }),
      signal: keyController.signal
    });
    clearTimeout(keyTimeout);

    if (!response.ok) {
      console.error('Fetch key error: HTTP ' + response.status);
      return;
    }
    var result = await response.json();
    if (result.success && result.streamKey) {
      var keyEl = document.getElementById('myStreamKey');
      if (keyEl) {
        keyEl.classList.remove('key-loading');
        keyEl.classList.add('key-reveal');
        keyEl.textContent = '';
        var keySpan = document.createElement('span');
        keySpan.className = 'key-text';
        keySpan.textContent = result.streamKey;
        keyEl.appendChild(keySpan);
      }
      mySlot.streamKey = result.streamKey;
      currentStreamKey = result.streamKey;
      updateButtPassword(result.streamKey);
    }
  } catch (e) {
    console.error('Fetch key error:', e);
  }
}

export async function openGoLiveInline() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var currentStream = ctx ? ctx.getCurrentStream() : null;

  if (currentStream && currentStream.djId !== (currentUser ? currentUser.uid : null)) {
    alert('Someone is already live! Use the Takeover feature if you want to take over.');
    return;
  }

  if (!currentStreamKey) {
    var keyStatusEl = document.getElementById('keyStatus');
    if (keyStatusEl) keyStatusEl.textContent = 'Loading...';
    await loadStreamKeyForGoLive();
  }

  var keySection = document.getElementById('streamKeySection');
  if (keySection) keySection.scrollIntoView({ behavior: 'smooth', block: 'center' });

  var keyStatusEl2 = document.getElementById('keyStatus');
  if (keyStatusEl2) {
    keyStatusEl2.textContent = 'Ready';
    keyStatusEl2.className = 'key-status ready';
  }
}

export async function loadStreamKeyForGoLive() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var userInfo = ctx ? ctx.getUserInfo() : null;
  var log = ctx ? ctx.log : function() {};
  var updateButtPassword = ctx ? ctx.updateButtPassword : function() {};
  var startObsPreviewCheck = ctx ? ctx.startObsPreviewCheck : function() {};
  var inlineKeyEl = document.getElementById('myStreamKey');

  if (!mySlot) {
    log('[GoLive] No booked slot - showing placeholder');
    if (inlineKeyEl) {
      inlineKeyEl.classList.remove('key-loading');
      inlineKeyEl.classList.add('key-unavailable');
      if (currentStream) {
        inlineKeyEl.innerHTML = '<span class="key-no-slot">Book a slot first</span>';
      } else {
        inlineKeyEl.innerHTML = '<span class="key-no-slot">Press I\'m Ready to go live</span>';
      }
    }
    return;
  }

  if (mySlot.streamKey) {
    log('[GoLive] Using stream key from booked slot: ' + mySlot.id);
    currentStreamKey = mySlot.streamKey;
    updateButtPassword(mySlot.streamKey);
    if (inlineKeyEl && !streamKeyDisplayed) {
      inlineKeyEl.classList.add('key-loading');
      inlineKeyEl.classList.remove('key-reveal', 'key-unavailable');
      inlineKeyEl.innerHTML = '<span class="key-generating"><span class="spawn-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> Spawning</span>';
      await new Promise(function(resolve) { setTimeout(resolve, 5000); });
      inlineKeyEl.classList.remove('key-loading');
      inlineKeyEl.classList.add('key-reveal');
      inlineKeyEl.textContent = '';
      var keySpan = document.createElement('span');
      keySpan.className = 'key-text';
      keySpan.textContent = mySlot.streamKey;
      inlineKeyEl.appendChild(keySpan);
      streamKeyDisplayed = true;
    }
    startObsPreviewCheck();
    return;
  }

  if (streamKeyDisplayed && currentStreamKey) {
    log('[GoLive] Stream key already displayed, skipping animation');
    startObsPreviewCheck();
    return;
  }

  if (inlineKeyEl) {
    inlineKeyEl.classList.add('key-loading');
    inlineKeyEl.classList.remove('key-reveal', 'key-unavailable');
    inlineKeyEl.innerHTML = '<span class="key-generating"><span class="spawn-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> Spawning</span>';
  }

  var minAnimationTime = 5000;
  var animationStart = Date.now();

  try {
    log('[GoLive] Step 1: Getting ID token...');
    if (!currentUser) {
      throw new Error('No authenticated user');
    }
    var token = await currentUser.getIdToken();
    log('[GoLive] Step 2: Got token, preparing request...');

    if (!userInfo || !userInfo.name) {
      throw new Error('User info not loaded yet');
    }
    log('[GoLive] Step 3: User info ready, name: ' + userInfo.name);

    log('[GoLive] Step 4: Making API request for slot: ' + mySlot.id);
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 15000);

    var response = await fetch('/api/livestream/slots/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        action: 'generate_key',
        djId: currentUser.uid,
        djName: userInfo.name,
        slotId: mySlot.id
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    log('[GoLive] Step 5: Got response, status: ' + response.status);

    if (!response.ok) {
      throw new Error('Server error: ' + response.status);
    }
    var result = await response.json();
    log('[GoLive] Step 6: Parsed response: ' + (result.success ? 'success' : result.error));

    var elapsed = Date.now() - animationStart;
    if (elapsed < minAnimationTime) {
      await new Promise(function(resolve) { setTimeout(resolve, minAnimationTime - elapsed); });
    }

    if (result.success && result.streamKey) {
      currentStreamKey = result.streamKey;
      streamKeyValidUntil = result.validUntil;
      updateButtPassword(result.streamKey);

      mySlot.streamKey = result.streamKey;

      if (inlineKeyEl) {
        inlineKeyEl.classList.remove('key-loading');
        inlineKeyEl.classList.add('key-reveal');
        inlineKeyEl.textContent = '';
        var keySpan2 = document.createElement('span');
        keySpan2.className = 'key-text';
        keySpan2.textContent = result.streamKey;
        inlineKeyEl.appendChild(keySpan2);
        streamKeyDisplayed = true;
      }
      log('[GoLive] New stream key generated for slot: ' + mySlot.id + ' valid until: ' + result.validUntil);
      startObsPreviewCheck();
    } else {
      if (inlineKeyEl) {
        inlineKeyEl.classList.remove('key-loading');
        inlineKeyEl.classList.remove('key-reveal');
        inlineKeyEl.textContent = 'Error - try again';
      }
      console.error('[GoLive] Failed to generate key:', result.error);
    }
  } catch (error) {
    console.error('[GoLive] Error loading stream key:', error);
    var errMsg = error instanceof Error ? error.message : String(error);
    var errName = error instanceof Error ? error.name : '';
    log('[GoLive] ERROR at stream key generation: ' + (errMsg || errName));
    if (inlineKeyEl) {
      inlineKeyEl.classList.remove('key-loading');
      inlineKeyEl.classList.remove('key-reveal');
      var errorMsg = 'Error - click to retry';
      if (errName === 'AbortError') {
        errorMsg = 'Timeout - click to retry';
      } else if (errMsg && errMsg.indexOf('User info') !== -1) {
        errorMsg = 'Please wait...';
      } else if (errMsg && errMsg.indexOf('authenticated') !== -1) {
        errorMsg = 'Please log in again';
      }
      inlineKeyEl.innerHTML = '<span style="color: #ff6b6b; cursor: pointer;" id="streamKeyRetryBtn">' + errorMsg + '</span>';
      var retryBtn = document.getElementById('streamKeyRetryBtn');
      if (retryBtn) {
        retryBtn.addEventListener('click', function() { loadStreamKeyForGoLive(); });
      }
    }
  }
}

export async function handleGoLiveReady() {
  var currentUser = ctx ? ctx.getCurrentUser() : null;
  var userInfo = ctx ? ctx.getUserInfo() : null;
  var currentStream = ctx ? ctx.getCurrentStream() : null;
  var log = ctx ? ctx.log : function() {};
  var loadStreamStatus = ctx ? ctx.loadStreamStatus : null;
  var updateEndStreamButton = ctx ? ctx.updateEndStreamButton : null;
  var initBroadcastMeters = ctx ? ctx.initBroadcastMeters : null;
  var animateLiveMeters = ctx ? ctx.animateLiveMeters : null;
  var currentStreamMode = ctx ? ctx.getCurrentStreamMode() : 'direct';
  var selectedRelaySource = ctx ? ctx.getSelectedRelaySource() : null;
  var broadcastMode = ctx ? ctx.getBroadcastMode() : 'placeholder';
  var currentPreviewSource = ctx ? ctx.getCurrentPreviewSource() : 'obs';
  var icecastAudioContext = ctx ? ctx.getIcecastAudioContext() : null;
  var icecastAnalyserL = ctx ? ctx.getIcecastAnalyserL() : null;
  var icecastAnalyserR = ctx ? ctx.getIcecastAnalyserR() : null;
  var icecastGainNode = ctx ? ctx.getIcecastGainNode() : null;
  var liveMeterAnimationId = ctx ? ctx.getLiveMeterAnimationId() : null;
  var broadcastMeterAnimationId = ctx ? ctx.getBroadcastMeterAnimationId() : null;

  var relayAudio = document.getElementById('relayAudio');

  if (relayAudio && !relayAudio.paused) {
    if (icecastGainNode) {
      icecastGainNode.gain.value = 0;
    } else {
      relayAudio.volume = 0;
    }

    if (icecastAudioContext && icecastAudioContext.state === 'suspended') {
      await icecastAudioContext.resume();
    }

    if (icecastAnalyserL && icecastAnalyserR) {
      if (!liveMeterAnimationId && animateLiveMeters) {
        animateLiveMeters();
      }
      if (!broadcastMeterAnimationId && initBroadcastMeters) {
        initBroadcastMeters();
      }
    }
  }

  var title, genre;

  var isRelayMode = currentStreamMode === 'relay';
  var userRelayUrl = isRelayMode && selectedRelaySource ? (selectedRelaySource.playbackUrl || 'https://stream.freshwax.co.uk/live/freshwax-main/index.m3u8') : null;
  var relaySourceName = selectedRelaySource ? (selectedRelaySource.name || 'External Source') : 'External Source';

  if (isRelayMode && selectedRelaySource && selectedRelaySource.nowPlaying) {
    title = selectedRelaySource.nowPlaying;
  } else {
    var titleEl = document.getElementById('inlineStreamTitle');
    title = titleEl ? (titleEl.value ? titleEl.value.trim() : '') : '';
    if (!title) title = 'Live Session';
  }
  var genreEl = document.getElementById('inlineStreamGenre');
  genre = genreEl ? (genreEl.value || 'Jungle / D&B') : 'Jungle / D&B';

  if (!isRelayMode && !currentStreamKey) {
    throw new Error('No stream key available. Please refresh and try again.');
  }

  if (isRelayMode && !selectedRelaySource) {
    throw new Error('Please select a radio station to relay from.');
  }

  log('[GoLive] Starting go live with key: ' + (currentStreamKey ? currentStreamKey.substring(0, 10) + '...' : 'N/A'));

  var token = await currentUser.getIdToken();

  var twitchUsernameEl = document.getElementById('twitchUsername');
  var twitchStreamKeyEl = document.getElementById('twitchStreamKey');
  var twitchUsername = twitchUsernameEl ? (twitchUsernameEl.value ? twitchUsernameEl.value.trim() : null) : null;
  var twitchStreamKeyVal = twitchStreamKeyEl ? (twitchStreamKeyEl.value ? twitchStreamKeyEl.value.trim() : null) : null;

  var avatarUrl = (userInfo ? userInfo.avatar : null) || (currentUser ? currentUser.photoURL : null) || '/place-holder.webp';

  var requestBody = {
    action: isRelayMode ? 'start_relay' : 'go_live',
    djId: currentUser.uid,
    djName: userInfo ? userInfo.name : 'DJ',
    djAvatar: avatarUrl,
    title: title,
    genre: genre,
    twitchUsername: twitchUsername || null,
    twitchStreamKey: twitchStreamKeyVal || null,
    broadcastMode: broadcastMode
  };

  if (isRelayMode) {
    requestBody.relayUrl = userRelayUrl;
    requestBody.stationName = relaySourceName;
  } else {
    requestBody.streamKey = currentStreamKey;
  }

  var goLiveController = new AbortController();
  var goLiveTimeout = setTimeout(function() { goLiveController.abort(); }, 30000);
  var response = await fetch('/api/livestream/slots/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(requestBody),
    signal: goLiveController.signal
  });
  clearTimeout(goLiveTimeout);

  if (!response.ok) {
    throw new Error('Server error: ' + response.status);
  }
  var result = await response.json();

  if (result.success) {
    log('[GoLive] Successfully went live!');

    if (loadStreamStatus) await loadStreamStatus();

    if (updateEndStreamButton) updateEndStreamButton(true, true);

    var readySection = document.getElementById('readySection');
    if (readySection) readySection.classList.add('hidden');

    var fastPollCount = 0;
    var currentStreamRef = ctx ? ctx.getCurrentStream() : null;
    var fastPollInterval = setInterval(async function() {
      fastPollCount++;
      log('[GoLive] Fast poll #' + fastPollCount);
      if (loadStreamStatus) await loadStreamStatus();
      currentStreamRef = ctx ? ctx.getCurrentStream() : null;
      if (fastPollCount >= 10 || (currentStreamRef && currentStreamRef.hlsUrl)) {
        clearInterval(fastPollInterval);
        log('[GoLive] Fast polling complete');
      }
    }, 3000);

    return true;
  } else {
    console.error('[GoLive] API Error:', result);

    var errorMsg = result.error || 'Failed to go live';
    if (result.details) errorMsg += ': ' + result.details;
    if (result.error === 'stream_not_detected') {
      errorMsg = 'Stream not detected. Make sure OBS is streaming with the correct key.';
    } else if (result.error === 'relay_failed') {
      errorMsg = 'Failed to connect to relay stream.';
    }

    throw new Error(errorMsg);
  }
}
