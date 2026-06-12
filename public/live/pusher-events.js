// public/live/pusher-events.js
// Live page — Pusher event handlers for live status

var liveStatusChannel = null;

export function getPusherConfig() {
  return {
    key: (window.PUSHER_CONFIG && window.PUSHER_CONFIG.key) || '',
    cluster: (window.PUSHER_CONFIG && window.PUSHER_CONFIG.cluster) || 'eu'
  };
}

export async function loadPusherScript() {
  if (window.Pusher) return;
  try {
    await new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://js.pusher.com/8.2.0/pusher.min.js';
      s.onload = function() { resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  } catch (e) {
    /* Pusher load failed */
  }
}

export async function setupLiveStatusPusher(deps) {
  var onCheckLiveStatus = deps.onCheckLiveStatus;
  var onStopLiveStream = deps.onStopLiveStream;

  try {
    var config = window.PUSHER_CONFIG;
    if (!config || !config.key) return;

    if (!window.Pusher) {
      await new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://js.pusher.com/8.2.0/pusher.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    if (!window.statusPusher) {
      window.statusPusher = new window.Pusher(config.key, {
        cluster: config.cluster,
        forceTLS: true
      });
    }

    if (liveStatusChannel) {
      liveStatusChannel.unbind_all();
      window.statusPusher.unsubscribe('live-status');
    }

    liveStatusChannel = window.statusPusher.subscribe('live-status');

    liveStatusChannel.bind('stream-started', function(data) {
      // A stream just started. Confirm it's actually live, RETRYING through the
      // status-cache propagation lag — otherwise a single stale "not live"
      // response strands listeners on the offline placeholder until the slow
      // 60s poll. window._awaitingLiveStart also suppresses the offline overlay
      // during this window (see showOfflineState in live-stream.js).
      window._awaitingLiveStart = Date.now();
      var attempts = 0;
      (function confirmLive() {
        attempts++;
        if (onCheckLiveStatus) onCheckLiveStatus(true);
        if (attempts >= 8) { window._awaitingLiveStart = 0; return; }
        setTimeout(function() {
          if (window.isLiveStreamActive) { window._awaitingLiveStart = 0; return; }
          confirmLive();
        }, Math.min(1500 * attempts, 4000));
      })();
      if (typeof window.refreshSchedule === 'function') window.refreshSchedule();
    });

    liveStatusChannel.bind('stream-ended', function(data) {
      if (onStopLiveStream) onStopLiveStream();
      if (onCheckLiveStatus) onCheckLiveStatus(true);
      if (typeof window.refreshSchedule === 'function') window.refreshSchedule();
    });
  } catch (e) {
    /* Pusher setup failed, falling back to polling */
  }
}

export function getLiveStatusChannel() {
  return liveStatusChannel;
}
