// public/whip-client.js
// WHIP (WebRTC-HTTP Ingestion Protocol) client for browser-based streaming
// Zero dependencies — uses native WebRTC APIs

/** @type {RTCPeerConnection|null} */
let pc = null;

/** @type {string|null} */
let resourceUrl = null;

/** @type {number|null} */
let statsInterval = null;

/**
 * Prefer H264 codec for better mobile compatibility
 * @param {RTCSessionDescription} offer
 * @returns {RTCSessionDescription}
 */
function preferH264(offer) {
  const sdp = offer.sdp;
  if (!sdp) return offer;

  // Find H264 payload types
  const h264Regex = /a=rtpmap:(\d+) H264\/\d+/gi;
  const h264Payloads = [];
  let match;
  while ((match = h264Regex.exec(sdp)) !== null) {
    h264Payloads.push(match[1]);
  }

  if (h264Payloads.length === 0) return offer;

  // Reorder video m= line to prefer H264
  const lines = sdp.split('\r\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('m=video')) {
      const parts = lines[i].split(' ');
      // parts: m=video PORT PROTO PT1 PT2 ...
      const header = parts.slice(0, 3);
      const payloads = parts.slice(3);
      // Move H264 payloads to front
      const reordered = [
        ...h264Payloads.filter(function(p) { return payloads.includes(p); }),
        ...payloads.filter(function(p) { return !h264Payloads.includes(p); })
      ];
      lines[i] = header.concat(reordered).join(' ');
      break;
    }
  }

  return new RTCSessionDescription({
    type: offer.type,
    sdp: lines.join('\r\n')
  });
}

/**
 * Connect to a WHIP endpoint
 * @param {string} whipUrl - The WHIP endpoint URL
 * @param {MediaStream} mediaStream - The local media stream (camera + mic)
 * @param {Object} callbacks
 * @param {function(string, Object=):void} [callbacks.onStateChange] - Connection state changes
 * @param {function(Object):void} [callbacks.onStats] - Periodic stats updates
 * @param {function(Error):void} [callbacks.onError] - Error callback
 * @returns {Promise<void>}
 */
export async function whipConnect(whipUrl, mediaStream, callbacks) {
  if (pc) {
    throw new Error('Already connected. Call whipDisconnect() first.');
  }

  callbacks = callbacks || {};

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  // Track connection state
  pc.onconnectionstatechange = function() {
    if (!pc) return;
    var state = pc.connectionState;
    if (callbacks.onStateChange) {
      callbacks.onStateChange(state);
    }
    if (state === 'failed' || state === 'closed') {
      cleanup();
    }
  };

  pc.oniceconnectionstatechange = function() {
    if (!pc) return;
    if (callbacks.onStateChange) {
      callbacks.onStateChange('ice-' + pc.iceConnectionState);
    }
  };

  // Add all tracks from the media stream
  mediaStream.getTracks().forEach(function(track) {
    pc.addTrack(track, mediaStream);
  });

  // Set video bitrate preferences via sender parameters
  var videoSender = pc.getSenders().find(function(s) { return s.track && s.track.kind === 'video'; });
  if (videoSender) {
    var params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    var isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    params.encodings[0].maxBitrate = isMobile ? 1000000 : 2500000; // 1 Mbps mobile, 2.5 Mbps desktop
    videoSender.setParameters(params).catch(function() {
      // Ignore — not all browsers support this
    });
  }

  // Create offer
  var offer = await pc.createOffer();
  offer = preferH264(offer);
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete (with timeout)
  var localDesc = await waitForIceGathering(pc, 8000);

  // Send offer to WHIP endpoint
  var response = await fetch(whipUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp'
    },
    body: localDesc.sdp
  });

  if (!response.ok) {
    var errText = '';
    try { errText = await response.text(); } catch (e) { /* ignore */ }
    pc.close();
    pc = null;
    throw new Error('WHIP server returned ' + response.status + ': ' + errText);
  }

  // Store the resource URL for later DELETE (disconnect)
  var location = response.headers.get('Location');
  if (location) {
    // Location may be relative or absolute — both work with fetch()
    resourceUrl = location;
  } else {
    // Fallback: use the WHIP URL itself
    resourceUrl = whipUrl;
  }

  // Set remote description from answer
  var answerSdp = await response.text();
  await pc.setRemoteDescription(new RTCSessionDescription({
    type: 'answer',
    sdp: answerSdp
  }));

  // Start stats polling
  if (callbacks.onStats) {
    statsInterval = setInterval(function() {
      whipGetStats().then(function(stats) {
        if (callbacks.onStats) callbacks.onStats(stats);
      }).catch(function() {
        // ignore stats errors
      });
    }, 2000);
  }
}

/**
 * Wait for ICE gathering to complete or timeout
 * @param {RTCPeerConnection} peerConnection
 * @param {number} timeoutMs
 * @returns {Promise<RTCSessionDescription>}
 */
function waitForIceGathering(peerConnection, timeoutMs) {
  return new Promise(function(resolve) {
    if (peerConnection.iceGatheringState === 'complete') {
      resolve(peerConnection.localDescription);
      return;
    }

    var resolved = false;
    var timeout = setTimeout(function() {
      if (!resolved) {
        resolved = true;
        resolve(peerConnection.localDescription);
      }
    }, timeoutMs);

    peerConnection.onicegatheringstatechange = function() {
      if (peerConnection.iceGatheringState === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(peerConnection.localDescription);
      }
    };
  });
}

/**
 * Disconnect from the WHIP endpoint
 * @returns {Promise<void>}
 */
export async function whipDisconnect() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  // Send DELETE to resource URL to signal end of stream
  if (resourceUrl) {
    try {
      await fetch(resourceUrl, { method: 'DELETE' });
    } catch (e) {
      // Best-effort cleanup, ignore errors
    }
    resourceUrl = null;
  }

  cleanup();
}

/**
 * Clean up the peer connection
 */
function cleanup() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange = null;
    try { pc.close(); } catch (e) { /* ignore */ }
    pc = null;
  }
}

/**
 * Replace a track while connected (e.g., camera flip)
 * @param {MediaStreamTrack} oldTrack - The track to replace
 * @param {MediaStreamTrack} newTrack - The new track to use
 * @returns {Promise<void>}
 */
export async function whipReplaceTrack(oldTrack, newTrack) {
  if (!pc) {
    throw new Error('Not connected');
  }

  var sender = pc.getSenders().find(function(s) {
    return s.track === oldTrack;
  });

  if (!sender) {
    throw new Error('Track not found in peer connection');
  }

  await sender.replaceTrack(newTrack);
}

/**
 * Get current connection stats (bitrate, FPS, round-trip time)
 * @returns {Promise<Object>}
 */
export async function whipGetStats() {
  if (!pc) {
    return { connected: false };
  }

  var stats = await pc.getStats();
  var result = {
    connected: pc.connectionState === 'connected',
    connectionState: pc.connectionState,
    videoBitrate: 0,
    audioBitrate: 0,
    fps: 0,
    roundTripTime: 0,
    jitter: 0
  };

  stats.forEach(function(report) {
    if (report.type === 'outbound-rtp' && report.kind === 'video') {
      result.videoBitrate = report.bytesSent || 0;
      result.fps = report.framesPerSecond || 0;
      result.framesSent = report.framesSent || 0;
      result.framesEncoded = report.framesEncoded || 0;
    }
    if (report.type === 'outbound-rtp' && report.kind === 'audio') {
      result.audioBitrate = report.bytesSent || 0;
    }
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      result.roundTripTime = report.currentRoundTripTime || 0;
    }
  });

  return result;
}

/**
 * Check if currently connected
 * @returns {boolean}
 */
export function whipIsConnected() {
  return pc !== null && pc.connectionState === 'connected';
}

/**
 * Set video bitrate
 * @param {number} bitrate - Target bitrate in bps
 * @returns {Promise<void>}
 */
export async function whipSetBitrate(bitrate) {
  if (!pc) return;

  var videoSender = pc.getSenders().find(function(s) {
    return s.track && s.track.kind === 'video';
  });

  if (videoSender) {
    var params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = bitrate;
    await videoSender.setParameters(params);
  }
}

// Auto-cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', function() {
    if (pc) {
      // Best-effort DELETE
      if (resourceUrl) {
        try {
          navigator.sendBeacon(resourceUrl, '');
        } catch (e) {
          // sendBeacon doesn't support DELETE, just cleanup locally
        }
      }
      cleanup();
    }
  });

  window.addEventListener('beforeunload', function() {
    if (pc) {
      cleanup();
    }
  });
}
