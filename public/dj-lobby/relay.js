/**
 * dj-lobby/relay.js — Relay system (station selection, preview, mode toggle)
 * Extracted from dj-lobby.astro inline JS.
 */

// Shared context set by init()
var ctx = null;

// Relay Sources - Hardcoded approved stations (no Firebase reads)
var APPROVED_RELAY_STATIONS = [
  {
    id: 'underground-lair',
    name: 'The Underground Lair',
    streamUrl: 'http://95.217.34.48:8340/stream3',
    httpsStreamUrl: 'https://relay.freshwax.co.uk/underground-lair',
    websiteUrl: 'https://www.theundergroundlair.fr',
    logoUrl: '/place-holder.webp',
    genre: 'Jungle / D&B / Breakcore',
    description: 'Underground Music Webradio',
    checkUrl: 'https://cressida.shoutca.st:2199/rpc/theundergroundlair/streaminfo.get'
  },
];

var relaySources = [];
var selectedRelaySource = null;
var currentStreamMode = 'direct'; // 'direct' or 'relay'
var relayHlsPlayer = null;
var savedTitle = '';

export function getRelaySources() { return relaySources; }
export function getSelectedRelaySource() { return selectedRelaySource; }
export function setSelectedRelaySource(src) { selectedRelaySource = src; }
export function getCurrentStreamMode() { return currentStreamMode; }
export function getSavedTitle() { return savedTitle; }
export function setSavedTitle(t) { savedTitle = t; }

export function init(sharedCtx) {
  ctx = sharedCtx;
}

export async function loadRelaySources() {
  relaySources = APPROVED_RELAY_STATIONS.map(function(s) {
    var hasHttpsUrl = !!(s.httpsStreamUrl || s.streamUrl.startsWith('https://'));
    var playbackUrl = s.httpsStreamUrl || (s.streamUrl.startsWith('https://') ? s.streamUrl : null);
    return Object.assign({}, s, {
      isCurrentlyLive: false,
      canPlay: hasHttpsUrl,
      playbackUrl: playbackUrl
    });
  });

  var relayResults = await Promise.all(relaySources.map(function(source) {
    return fetch('/api/relay-status/?station=' + source.id, {
      signal: AbortSignal.timeout(8000)
    }).then(function(response) {
      return response.ok ? response.json() : null;
    }).catch(function() {
      return null;
    });
  }));

  relaySources.forEach(function(source, i) {
    var result = relayResults[i];
    if (result) {
      source.isCurrentlyLive = result.isLive || false;
      var nowPlaying = result.nowPlaying || '';
      if (nowPlaying.toLowerCase().startsWith('unknown - ')) {
        nowPlaying = nowPlaying.substring(10).trim();
      }
      source.nowPlaying = nowPlaying;
      source.listeners = result.listeners || 0;
    } else {
      source.isCurrentlyLive = false;
    }
  });

  renderRelaySources();
}

export function renderRelaySources() {
  var container = document.getElementById('relaySourcesList');
  if (!container) return;
  var escapeHtml = ctx.escapeHtml;

  if (relaySources.length === 0) {
    container.innerHTML = '<div class="no-sources-message">No radio stations configured yet</div>';
    return;
  }

  container.innerHTML = relaySources.map(function(source) {
    return '<div class="relay-source-item ' + (selectedRelaySource && selectedRelaySource.id === source.id ? 'selected' : '') + ' ' + (!source.canPlay ? 'no-playback' : '') + '"'
      + ' data-id="' + source.id + '"'
      + ' data-url="' + escapeHtml(source.playbackUrl || '') + '"'
      + ' data-name="' + escapeHtml(source.name) + '"'
      + ' data-now-playing="' + escapeHtml(source.nowPlaying || '') + '"'
      + ' data-listeners="' + (source.listeners || 0) + '"'
      + ' data-can-play="' + source.canPlay + '">'
      + '<img src="' + escapeHtml(source.logoUrl || '/place-holder.webp') + '" alt="' + escapeHtml(source.name) + '" class="relay-source-logo" width="40" height="40" loading="lazy" />'
      + '<div class="relay-source-info">'
      + '<div class="relay-source-name">' + escapeHtml(source.name) + '</div>'
      + '<div class="relay-source-genre">' + (source.isCurrentlyLive && source.nowPlaying ? escapeHtml(source.nowPlaying) : escapeHtml(source.genre || 'Various')) + '</div>'
      + (!source.canPlay ? '<div class="relay-source-warning" style="color:#f59e0b;font-size:0.65rem;">Needs HTTPS relay</div>' : '')
      + '</div>'
      + '<span class="relay-source-status ' + (source.isCurrentlyLive ? 'live' : 'offline') + '">'
      + (source.isCurrentlyLive ? 'Live (' + (source.listeners || 0) + ')' : 'Offline')
      + '</span>'
      + '</div>';
  }).join('');

  container.querySelectorAll('.relay-source-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var canPlay = item.dataset.canPlay === 'true';
      if (!canPlay) {
        alert('This station requires an HTTPS relay to be configured. The stream is HTTP-only and cannot be played on HTTPS pages.');
        return;
      }
      container.querySelectorAll('.relay-source-item').forEach(function(i) { i.classList.remove('selected'); });
      item.classList.add('selected');
      selectedRelaySource = {
        id: item.dataset.id,
        url: item.dataset.url,
        name: item.dataset.name,
        nowPlaying: item.dataset.nowPlaying || '',
        listeners: parseInt(item.dataset.listeners) || 0
      };
      updateRelayPreview();
    });
  });
}

export function setStreamMode(mode) {
  currentStreamMode = mode;
  var escapeHtml = ctx.escapeHtml;
  var log = ctx.log;
  var directBtn = document.getElementById('directModeBtn');
  var relayBtn = document.getElementById('relayModeBtn');
  var directSection = document.getElementById('directStreamSection');
  var relaySection = document.getElementById('relayStreamSection');
  var relayPreview = document.getElementById('relayPreview');
  var obsOfflineState = document.getElementById('obsOfflineState');
  var obsVideoPreview = document.getElementById('obsVideoPreview');
  var buttAudioPreview = document.getElementById('buttAudioPreview');

  var obsIndicator = document.getElementById('obsIndicator');
  var buttIndicator = document.getElementById('buttIndicator');
  var relayIndicator = document.getElementById('relayIndicator');
  var relayDot = document.getElementById('relayDot');
  var previewRelayDot = document.getElementById('previewRelayDot');

  if (mode === 'relay') {
    if (directBtn) directBtn.classList.remove('active');
    if (relayBtn) relayBtn.classList.add('active');
    if (directSection) directSection.classList.add('hidden');
    if (relaySection) relaySection.classList.remove('hidden');
    if (relayPreview) relayPreview.classList.remove('hidden');
    if (obsOfflineState) obsOfflineState.classList.add('hidden');
    if (obsVideoPreview) obsVideoPreview.classList.add('hidden');
    if (buttAudioPreview) buttAudioPreview.classList.add('hidden');
    if (obsIndicator) { obsIndicator.classList.add('disabled'); obsIndicator.classList.remove('active'); }
    if (buttIndicator) { buttIndicator.classList.add('disabled'); buttIndicator.classList.remove('active'); }
    if (relayIndicator) { relayIndicator.classList.add('active'); relayIndicator.classList.remove('disabled'); }
    renderInlineRelayStations();
    updateRelayPreview();
  } else {
    if (directBtn) directBtn.classList.add('active');
    if (relayBtn) relayBtn.classList.remove('active');
    if (directSection) directSection.classList.remove('hidden');
    if (relaySection) relaySection.classList.add('hidden');
    if (relayPreview) relayPreview.classList.add('hidden');
    if (obsOfflineState) obsOfflineState.classList.remove('hidden');
    if (obsIndicator) obsIndicator.classList.remove('disabled');
    if (buttIndicator) buttIndicator.classList.remove('disabled');
    if (relayIndicator) { relayIndicator.classList.add('disabled'); relayIndicator.classList.remove('active'); }
    if (relayDot) { relayDot.classList.remove('connected'); relayDot.classList.add('disconnected'); }
    if (previewRelayDot) { previewRelayDot.classList.remove('connected'); previewRelayDot.classList.add('disconnected'); }
    var relayAudio = document.getElementById('relayAudio');
    if (relayAudio) {
      relayAudio.muted = true;
    }
    selectedRelaySource = null;
  }
  log('[StreamMode] Set to:', mode);
}

export function updateRelayPreview() {
  var escapeHtml = ctx.escapeHtml;
  var userInfo = ctx.getUserInfo();
  var djNameEl = document.getElementById('relayPreviewDjName');
  var stationNameEl = document.getElementById('relayPreviewStationName');
  var vinylAvatar1 = document.getElementById('relayVinylAvatar');
  var vinylAvatar2 = document.getElementById('relayVinylAvatar2');
  var relayDot = document.getElementById('relayDot');
  var previewRelayDot = document.getElementById('previewRelayDot');

  if (djNameEl) {
    if (selectedRelaySource && selectedRelaySource.nowPlaying) {
      djNameEl.innerHTML = '<span style="color: #ef4444;">' + escapeHtml(selectedRelaySource.nowPlaying) + '</span>';
    } else if (userInfo && userInfo.name) {
      djNameEl.textContent = userInfo.name;
      djNameEl.style.color = '';
    }
  }

  if (stationNameEl && selectedRelaySource && selectedRelaySource.name) {
    if (savedTitle) {
      stationNameEl.innerHTML = savedTitle;
    } else {
      stationNameEl.innerHTML = 'Relayed from <span class="brand-fresh">' + escapeHtml(selectedRelaySource.name) + '</span>';
    }
  } else if (stationNameEl) {
    stationNameEl.innerHTML = '<span style="color:#888">Select a station below</span>';
    if (relayDot) { relayDot.classList.remove('connected'); relayDot.classList.add('disconnected'); }
    if (previewRelayDot) { previewRelayDot.classList.remove('connected'); previewRelayDot.classList.add('disconnected'); }
  }

  var avatarUrl = '/place-holder.webp';
  if (vinylAvatar1) vinylAvatar1.src = avatarUrl;
  if (vinylAvatar2) vinylAvatar2.src = avatarUrl;
}

export async function startRelayAudioPreview(stationUrl) {
  var relayAudio = document.getElementById('relayAudio');
  var relayDot = document.getElementById('relayDot');
  var previewRelayDot = document.getElementById('previewRelayDot');

  console.debug('[RelayPreview] Starting relay audio preview:', stationUrl);

  if (!relayAudio) {
    console.error('[RelayPreview] relayAudio element not found');
    return;
  }

  if (!stationUrl) {
    console.error('[RelayPreview] No station URL provided');
    return;
  }

  if (relayHlsPlayer) {
    relayHlsPlayer.destroy();
    relayHlsPlayer = null;
  }

  relayAudio.onplaying = function() {
    console.debug('[RelayPreview] Audio connected and playing, volume:', relayAudio.volume, 'muted:', relayAudio.muted);
    if (relayDot) { relayDot.classList.remove('disconnected'); relayDot.classList.add('connected'); }
    if (previewRelayDot) { previewRelayDot.classList.remove('disconnected'); previewRelayDot.classList.add('connected'); }

    if (!ctx.getIcecastAudioContext()) {
      ctx.setupIcecastAnalysers(relayAudio);
      console.debug('[RelayPreview] Icecast analysers initialized');
    }
    ctx.setCurrentPreviewSource('relay');
    setTimeout(function() {
      if (window.forceStartPreviewMeters) {
        window.forceStartPreviewMeters();
      }
      if (window.forceStartLiveMeters) {
        window.forceStartLiveMeters();
      }
    }, 50);
  };

  relayAudio.onerror = function(e) {
    console.error('[RelayPreview] Audio connection error:', e, relayAudio.error);
    if (relayDot) { relayDot.classList.remove('connected'); relayDot.classList.add('disconnected'); }
    if (previewRelayDot) { previewRelayDot.classList.remove('connected'); previewRelayDot.classList.add('disconnected'); }
  };

  relayAudio.volume = 1.0;
  relayAudio.muted = false;

  if (stationUrl.includes('.m3u8')) {
    console.debug('[RelayPreview] Using HLS.js for m3u8 stream');
    if (typeof Hls === 'undefined') {
      try {
        await new Promise(function(resolve, reject) {
          var s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.12/dist/hls.min.js';
          s.crossOrigin = 'anonymous';
          s.onload = resolve;
          s.onerror = function() { reject(new Error('Failed to load HLS.js')); };
          document.head.appendChild(s);
        });
      } catch (err) {
        console.warn('[RelayPreview] HLS.js load failed:', err);
      }
    }
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      relayHlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });
      relayHlsPlayer.loadSource(stationUrl);
      relayHlsPlayer.attachMedia(relayAudio);
      relayHlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
        console.debug('[RelayPreview] HLS manifest parsed, playing...');
        relayAudio.play().catch(function(e) {
          console.error('[RelayPreview] HLS play failed:', e.name, e.message);
        });
      });
      relayHlsPlayer.on(Hls.Events.ERROR, function(event, data) {
        console.error('[RelayPreview] HLS error:', data.type, data.details);
      });
    } else if (relayAudio.canPlayType('application/vnd.apple.mpegurl')) {
      relayAudio.src = stationUrl;
      relayAudio.play().catch(function(e) { console.error('[RelayPreview] Safari HLS play failed:', e); });
    } else {
      console.error('[RelayPreview] HLS not supported');
    }
  } else {
    relayAudio.src = stationUrl;
    console.debug('[RelayPreview] Set src, attempting to play...');
    relayAudio.play().then(function() {
      console.debug('[RelayPreview] Play started successfully');
    }).catch(function(e) {
      console.error('[RelayPreview] Audio play failed:', e.name, e.message);
      if (e.name === 'NotAllowedError') {
        console.debug('[RelayPreview] Autoplay blocked - user interaction needed');
      }
    });
  }
}

export function renderInlineRelayStations() {
  var container = document.getElementById('relayStationsInline');
  if (!container) return;
  var escapeHtml = ctx.escapeHtml;
  var log = ctx.log;

  if (relaySources.length === 0) {
    container.innerHTML = '<div class="relay-station-card"><span style="color:#888">Loading stations...</span></div>';
    loadRelaySources().then(function() { renderInlineRelayStations(); });
    return;
  }

  container.innerHTML = relaySources.map(function(source) {
    return '<div class="relay-station-card ' + (selectedRelaySource && selectedRelaySource.id === source.id ? 'selected' : '') + ' ' + (!source.canPlay ? 'no-playback' : '') + '"'
      + ' data-id="' + source.id + '"'
      + ' data-url="' + escapeHtml(source.playbackUrl || '') + '"'
      + ' data-name="' + escapeHtml(source.name) + '"'
      + ' data-nowplaying="' + escapeHtml(source.nowPlaying || '') + '"'
      + ' data-live="' + (source.isCurrentlyLive ? 'true' : 'false') + '"'
      + ' data-can-play="' + source.canPlay + '">'
      + '<img src="' + escapeHtml(source.logoUrl || '/place-holder.webp') + '" alt="' + escapeHtml(source.name) + '" class="relay-station-logo" width="40" height="40" loading="lazy" />'
      + '<div class="relay-station-info">'
      + '<div class="relay-station-name">' + escapeHtml(source.name) + '</div>'
      + '<div class="relay-station-genre">' + escapeHtml(source.genre || 'Various') + '</div>'
      + (source.nowPlaying ? '<div class="relay-station-genre" style="color:#ef4444;font-size:0.7rem;">Now: ' + escapeHtml(source.nowPlaying.substring(0, 30)) + (source.nowPlaying.length > 30 ? '...' : '') + '</div>' : '')
      + (!source.canPlay ? '<div style="color:#f59e0b;font-size:0.6rem;">Needs HTTPS relay</div>' : '')
      + '</div>'
      + '<span class="relay-station-badge ' + (source.isCurrentlyLive ? 'live' : 'offline') + '">'
      + (source.isCurrentlyLive ? 'LIVE' : 'OFFLINE')
      + '</span>'
      + '</div>';
  }).join('');

  container.querySelectorAll('.relay-station-card').forEach(function(card) {
    card.addEventListener('click', function() {
      var canPlay = card.dataset.canPlay === 'true';
      if (!canPlay) {
        alert('This station requires an HTTPS relay to be configured. The stream is HTTP-only and cannot be played on HTTPS pages.');
        return;
      }
      container.querySelectorAll('.relay-station-card').forEach(function(c) { c.classList.remove('selected'); });
      card.classList.add('selected');
      selectedRelaySource = {
        id: card.dataset.id,
        url: card.dataset.url,
        playbackUrl: card.dataset.url,
        name: card.dataset.name,
        nowPlaying: card.dataset.nowplaying || '',
        isLive: card.dataset.live === 'true'
      };
      log('[Relay] Selected station:', selectedRelaySource.name, 'Live:', selectedRelaySource.isLive, 'Now playing:', selectedRelaySource.nowPlaying);
      updateRelayPreview();
      var previewUrl = selectedRelaySource.playbackUrl || 'https://stream.freshwax.co.uk/live/freshwax-main/index.m3u8';
      console.debug('[Relay] Using preview URL:', previewUrl);
      startRelayAudioPreview(previewUrl);
      document.getElementById('broadcastAudioPanel')?.classList.remove('hidden');
      var relayAudio = document.getElementById('relayAudio');
      if (relayAudio && !ctx.getIcecastAudioContext()) {
        var initRelayAnalysers = function() {
          if (!ctx.getIcecastAudioContext()) {
            ctx.setupIcecastAnalysers(relayAudio);
            ctx.setCurrentPreviewSource('relay');
            ctx.updateAudioSourceIndicator('relay');
            ctx.initBroadcastMeters();
            setTimeout(function() {
              if (window.forceStartPreviewMeters) {
                window.forceStartPreviewMeters();
              } else if (window.startPreviewMeterAnimation) {
                window.startPreviewMeterAnimation();
              }
            }, 100);
            setTimeout(function() {
              if (window.forceStartLiveMeters) {
                window.forceStartLiveMeters();
              }
            }, 100);
          }
        };

        if (!relayAudio.paused) {
          initRelayAnalysers();
        } else {
          relayAudio.addEventListener('playing', initRelayAnalysers, { once: true });
        }
      } else if (ctx.getIcecastAudioContext()) {
        ctx.setCurrentPreviewSource('relay');
        ctx.updateAudioSourceIndicator('relay');
        ctx.initBroadcastMeters();
      }
    });
  });
}

export function setupRelayEventListeners() {
  var escapeHtml = ctx.escapeHtml;
  var log = ctx.log;

  // Open relay modal
  document.getElementById('openRelayModal')?.addEventListener('click', function() {
    document.getElementById('relaySourcesModal').classList.remove('hidden');
    loadRelaySources();
  });

  // Close relay modal
  document.getElementById('closeRelayModal')?.addEventListener('click', function() {
    document.getElementById('relaySourcesModal').classList.add('hidden');
  });

  // Click outside modal to close
  document.getElementById('relaySourcesModal')?.addEventListener('click', function(e) {
    if (e.target.id === 'relaySourcesModal') {
      document.getElementById('relaySourcesModal').classList.add('hidden');
    }
  });

  // Clear relay selection
  document.getElementById('clearRelaySource')?.addEventListener('click', function() {
    selectedRelaySource = null;
    document.getElementById('relayUrl').value = '';
    document.getElementById('relaySourceName').textContent = '';
    document.getElementById('relaySourcesList').querySelectorAll('.relay-source-item').forEach(function(i) { i.classList.remove('selected'); });
    document.getElementById('relaySourcesModal').classList.add('hidden');
  });

  // Confirm relay selection
  document.getElementById('confirmRelaySource')?.addEventListener('click', function() {
    if (selectedRelaySource) {
      document.getElementById('relayUrl').value = selectedRelaySource.url;
      document.getElementById('relaySourceName').textContent = 'Relaying from: ' + selectedRelaySource.name;
    }
    document.getElementById('relaySourcesModal').classList.add('hidden');
  });

  // Mode toggle button handlers
  document.getElementById('directModeBtn')?.addEventListener('click', function() { setStreamMode('direct'); });
  document.getElementById('relayModeBtn')?.addEventListener('click', function() { setStreamMode('relay'); });

  // Title Save button
  document.getElementById('saveTitleBtn')?.addEventListener('click', function() {
    var titleInput = document.getElementById('inlineStreamTitle');
    var saveBtn = document.getElementById('saveTitleBtn');
    var clearBtn = document.getElementById('clearTitleBtn');
    var savedMsg = document.getElementById('titleSavedMsg');

    if (!titleInput || !titleInput.value || !titleInput.value.trim()) {
      if (titleInput) titleInput.focus();
      return;
    }

    savedTitle = escapeHtml(titleInput.value.trim());
    titleInput.readOnly = true;
    titleInput.style.background = '#0a0a0a';
    titleInput.style.color = '#22c55e';

    if (saveBtn) saveBtn.classList.add('saved');
    if (clearBtn) clearBtn.classList.remove('hidden');
    if (savedMsg) savedMsg.classList.remove('hidden');
    setTimeout(function() { if (savedMsg) savedMsg.classList.add('hidden'); }, 2000);

    if (currentStreamMode === 'relay') {
      var relayPreviewStationName = document.getElementById('relayPreviewStationName');
      if (relayPreviewStationName) {
        relayPreviewStationName.innerHTML = savedTitle;
      }
    }
    var buttPreviewShowTitle = document.getElementById('buttPreviewShowTitle');
    if (buttPreviewShowTitle) {
      buttPreviewShowTitle.innerHTML = savedTitle;
    }

    log('[Title] Saved:', savedTitle);
  });

  // Title Clear button
  document.getElementById('clearTitleBtn')?.addEventListener('click', function() {
    var titleInput = document.getElementById('inlineStreamTitle');
    var saveBtn = document.getElementById('saveTitleBtn');
    var clearBtn = document.getElementById('clearTitleBtn');

    savedTitle = '';
    if (titleInput) {
      titleInput.value = '';
      titleInput.readOnly = false;
      titleInput.style.background = '';
      titleInput.style.color = '';
      titleInput.focus();
    }

    if (saveBtn) saveBtn.classList.remove('saved');
    if (clearBtn) clearBtn.classList.add('hidden');

    if (currentStreamMode === 'relay' && selectedRelaySource && selectedRelaySource.name) {
      var relayPreviewStationName = document.getElementById('relayPreviewStationName');
      if (relayPreviewStationName) {
        relayPreviewStationName.innerHTML = 'Relayed from <span class="brand-fresh">' + escapeHtml(selectedRelaySource.name) + '</span>';
      }
    }
    var buttPreviewShowTitle = document.getElementById('buttPreviewShowTitle');
    if (buttPreviewShowTitle) {
      buttPreviewShowTitle.innerHTML = 'Live on <span class="brand-fresh">Fresh</span> <span class="brand-wax">Wax</span>';
    }

    log('[Title] Cleared');
  });
}
