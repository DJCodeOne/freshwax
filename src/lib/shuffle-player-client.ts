// src/lib/shuffle-player-client.ts
// Extracted from ShufflePlayer.astro — client-side shuffle player controller
import { escapeHtml } from './escape-html';

var ShufflePlayer = {
  tracks: [] as Array<{
    id: string;
    title: string;
    artist: string;
    releaseTitle: string;
    releaseId: string;
    artwork: string;
    previewUrl: string;
    duration?: string | number | null;
  }>,
  shuffledTracks: [] as Array<{
    id: string;
    title: string;
    artist: string;
    releaseTitle: string;
    releaseId: string;
    artwork: string;
    previewUrl: string;
    duration?: string | number | null;
  }>,
  currentIndex: 0,
  isPlaying: false,
  isShuffleEnabled: true,
  audio: null as HTMLAudioElement | null,
  volume: 0.7,
  CLIP_START: 30,     // Start 30 seconds in
  CLIP_DURATION: 60,  // Play for 60 seconds
  clipEndTime: 90,    // CLIP_START + CLIP_DURATION
  seeked: false,

  // DOM Elements
  els: {} as Record<string, HTMLElement | null>,

  init: function() {
    var container = document.getElementById('shuffle-player-container');
    if (!container) return;

    // Load tracks from data attribute
    try {
      var tracksData = container.getAttribute('data-tracks');
      this.tracks = JSON.parse(tracksData || '[]');
    } catch (e){
      console.error('[ShufflePlayer] Failed to parse tracks:', e);
      this.tracks = [];
    }

    if (this.tracks.length === 0) {
      return;
    }


    // Cache DOM elements
    this.els = {
      container: container,
      status: document.getElementById('shuffle-status'),
      statusText: container.querySelector('.status-text'),
      nowPlaying: document.getElementById('shuffle-now-playing'),
      artwork: document.getElementById('shuffle-artwork'),
      trackTitle: document.getElementById('shuffle-track-title'),
      trackArtist: document.getElementById('shuffle-track-artist'),
      releaseLink: document.getElementById('shuffle-release-link'),
      releaseTitle: document.getElementById('shuffle-release-title'),
      progressContainer: document.getElementById('shuffle-progress-container'),
      progress: document.getElementById('shuffle-progress'),
      currentTime: document.getElementById('shuffle-current-time'),
      duration: document.getElementById('shuffle-duration'),
      playBtn: document.getElementById('shuffle-play-btn'),
      playIcon: document.getElementById('shuffle-play-icon'),
      pauseIcon: document.getElementById('shuffle-pause-icon'),
      prevBtn: document.getElementById('shuffle-prev'),
      nextBtn: document.getElementById('shuffle-next'),
      shuffleToggle: document.getElementById('shuffle-toggle'),
      volumeSlider: document.getElementById('shuffle-volume'),
      muteBtn: document.getElementById('shuffle-mute'),
      volumeIcon: document.getElementById('volume-icon'),
      volumeMutedIcon: document.getElementById('volume-muted-icon'),
      queueList: document.getElementById('shuffle-queue-list')
    };

    // Create audio element
    this.audio = new Audio();
    this.audio.volume = this.volume;
    this.audio.preload = 'none';

    // Shuffle tracks initially
    this.shuffleTracks();

    // Bind events
    this.bindEvents();

    // Update queue display
    this.updateQueueDisplay();
  },

  shuffleTracks: function() {
    this.shuffledTracks = this.tracks.slice();
    for (var i = this.shuffledTracks.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = this.shuffledTracks[i];
      this.shuffledTracks[i] = this.shuffledTracks[j];
      this.shuffledTracks[j] = temp;
    }
    this.currentIndex = 0;
  },

  bindEvents: function() {
    var self = this;
    var audio = this.audio;
    if (!audio) return;

    // Play/Pause
    if (this.els.playBtn) {
      this.els.playBtn.onclick = function() {
        if (self.isPlaying) {
          self.pause();
        } else {
          self.play();
        }
      };
    }

    // Previous
    if (this.els.prevBtn) {
      this.els.prevBtn.onclick = function() {
        self.playPrevious();
      };
    }

    // Next
    if (this.els.nextBtn) {
      this.els.nextBtn.onclick = function() {
        self.playNext();
      };
    }

    // Shuffle toggle
    if (this.els.shuffleToggle) {
      this.els.shuffleToggle.onclick = function() {
        self.isShuffleEnabled = !self.isShuffleEnabled;
        if (self.isShuffleEnabled) {
          self.els.shuffleToggle?.classList.add('shuffle-active');
          if (self.els.shuffleToggle) self.els.shuffleToggle.title = 'Shuffle On';
          self.shuffleTracks();
        } else {
          self.els.shuffleToggle?.classList.remove('shuffle-active');
          if (self.els.shuffleToggle) self.els.shuffleToggle.title = 'Shuffle Off';
          self.shuffledTracks = self.tracks.slice();
          self.currentIndex = 0;
        }
        self.updateQueueDisplay();
      };
    }

    // Volume
    if (this.els.volumeSlider) {
      (this.els.volumeSlider as HTMLInputElement).oninput = function(this: HTMLInputElement) {
        self.volume = Number(this.value) / 100;
        if (audio) audio.volume = self.volume;
        self.updateVolumeIcon();
      };
    }

    // Mute
    if (this.els.muteBtn) {
      this.els.muteBtn.onclick = function() {
        if (!audio) return;
        audio.muted = !audio.muted;
        self.updateVolumeIcon();
      };
    }

    // Progress bar click — seek within clip window
    if (this.els.progressContainer) {
      this.els.progressContainer.onclick = function(e) {
        if (!audio || !audio.duration || !isFinite(audio.duration)) return;
        var bar = self.els.progressContainer?.querySelector('.shuffle-progress-bar');
        if (!bar) return;
        var rect = bar.getBoundingClientRect();
        var progress = (e.clientX - rect.left) / rect.width;
        var dur = audio.duration;
        var clipStart = dur > self.CLIP_START ? self.CLIP_START : 0;
        var clipLen = self.clipEndTime - clipStart;
        audio.currentTime = clipStart + (progress * clipLen);
      };
    }

    // Audio events
    audio.ontimeupdate = function() {
      self.updateProgress();
    };

    audio.onloadedmetadata = function() {
      if (!audio) return;
      var dur = audio.duration;
      // Calculate clip boundaries based on track length
      if (dur > self.CLIP_START + self.CLIP_DURATION) {
        // Track long enough: play 60s starting at 30s
        self.clipEndTime = self.CLIP_START + self.CLIP_DURATION;
        if (self.els.duration) self.els.duration.textContent = self.formatTime(self.CLIP_DURATION);
      } else if (dur > self.CLIP_START) {
        // Track shorter but > 30s: start at 30s, play to end
        self.clipEndTime = dur;
        if (self.els.duration) self.els.duration.textContent = self.formatTime(dur - self.CLIP_START);
      } else {
        // Track very short: play from start, full length
        self.clipEndTime = dur;
        if (self.els.duration) self.els.duration.textContent = self.formatTime(dur);
      }
    };

    audio.oncanplay = function() {
      if (!self.seeked && audio) {
        self.seeked = true;
        var dur = audio.duration;
        if (dur > self.CLIP_START) {
          audio.currentTime = self.CLIP_START;
        }
      }
    };

    audio.onended = function() {
      self.playNext();
    };

    audio.onplay = function() {
      self.isPlaying = true;
      self.updatePlayButton();
      self.updateStatus('playing', 'Playing');

      // Pause global mini player if exists
      self.pauseGlobalPlayer();

      // Stop ReleasePlate audio
      self.stopReleasePlateAudio();
    };

    audio.onpause = function() {
      self.isPlaying = false;
      self.updatePlayButton();
      self.updateStatus('paused', 'Paused');
    };

    audio.onerror = function() {
      console.error('[ShufflePlayer] Audio error, skipping to next');
      self.playNext();
    };
  },

  play: function() {
    if (this.shuffledTracks.length === 0 || !this.audio) return;

    var track = this.shuffledTracks[this.currentIndex];
    if (!track) {
      this.currentIndex = 0;
      track = this.shuffledTracks[0];
    }

    // If audio source changed, load new track
    if (this.audio.src !== track.previewUrl) {
      this.loadTrack(track);
    }

    this.audio.play().catch(function(err) {
      console.error('[ShufflePlayer] Play failed:', err);
    });
  },

  pause: function() {
    if (this.audio) this.audio.pause();
  },

  loadTrack: function(track: { previewUrl: string; artwork: string; title: string; artist: string; releaseTitle: string; releaseId: string }) {
    if (!this.audio) return;
    this.seeked = false;
    this.audio.src = track.previewUrl;
    this.audio.load();

    // Update UI
    this.els.nowPlaying?.classList.remove('hidden');
    if (this.els.artwork) (this.els.artwork as HTMLImageElement).src = track.artwork || '/place-holder.webp';
    if (this.els.trackTitle) this.els.trackTitle.textContent = track.title;
    if (this.els.trackArtist) this.els.trackArtist.textContent = track.artist;
    if (this.els.releaseTitle) this.els.releaseTitle.textContent = track.releaseTitle;
    if (this.els.releaseLink) (this.els.releaseLink as HTMLAnchorElement).href = '/item/' + track.releaseId;

    // Reset progress
    if (this.els.progress) (this.els.progress as HTMLElement).style.width = '0%';
    if (this.els.currentTime) this.els.currentTime.textContent = '0:00';
    if (this.els.duration) this.els.duration.textContent = '1:00';

    // Update queue
    this.updateQueueDisplay();
  },

  playNext: function() {
    this.currentIndex++;
    if (this.currentIndex >= this.shuffledTracks.length) {
      // Reshuffle when reaching the end
      if (this.isShuffleEnabled) {
        this.shuffleTracks();
      } else {
        this.currentIndex = 0;
      }
    }
    this.loadTrack(this.shuffledTracks[this.currentIndex]);
    this.play();
  },

  playPrevious: function() {
    // If more than 3 seconds in, restart current track
    if (this.audio && this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }

    this.currentIndex--;
    if (this.currentIndex < 0) {
      this.currentIndex = this.shuffledTracks.length - 1;
    }
    this.loadTrack(this.shuffledTracks[this.currentIndex]);
    this.play();
  },

  playFromQueue: function(index: number) {
    this.currentIndex = index;
    this.loadTrack(this.shuffledTracks[this.currentIndex]);
    this.play();
  },

  updateProgress: function() {
    if (!this.audio || !this.audio.duration || !isFinite(this.audio.duration)) return;
    var dur = this.audio.duration;
    var ct = this.audio.currentTime;
    var clipStart = dur > this.CLIP_START ? this.CLIP_START : 0;
    var clipLen = this.clipEndTime - clipStart;

    // Auto-advance when clip time is up
    if (ct >= this.clipEndTime) {
      this.playNext();
      return;
    }

    // Show progress relative to the clip window
    var elapsed = ct - clipStart;
    if (elapsed < 0) elapsed = 0;
    var progress = clipLen > 0 ? (elapsed / clipLen) * 100 : 0;
    if (this.els.progress) (this.els.progress as HTMLElement).style.width = progress + '%';
    if (this.els.currentTime) this.els.currentTime.textContent = this.formatTime(elapsed);
  },

  updatePlayButton: function() {
    if (this.isPlaying) {
      this.els.playIcon?.classList.add('hidden');
      this.els.pauseIcon?.classList.remove('hidden');
    } else {
      this.els.playIcon?.classList.remove('hidden');
      this.els.pauseIcon?.classList.add('hidden');
    }
  },

  updateStatus: function(state: string, text: string) {
    if (this.els.status) this.els.status.className = 'shuffle-status ' + state;
    if (this.els.statusText) this.els.statusText.textContent = text;
  },

  updateVolumeIcon: function() {
    if ((this.audio && this.audio.muted) || this.volume === 0) {
      this.els.volumeIcon?.classList.add('hidden');
      this.els.volumeMutedIcon?.classList.remove('hidden');
    } else {
      this.els.volumeIcon?.classList.remove('hidden');
      this.els.volumeMutedIcon?.classList.add('hidden');
    }
  },

  updateQueueDisplay: function() {
    var self = this;
    if (!this.els.queueList) return;
    var upcoming = this.shuffledTracks.slice(this.currentIndex + 1, this.currentIndex + 6);

    if (upcoming.length === 0) {
      this.els.queueList.innerHTML = '<span class="queue-empty">End of queue</span>';
      return;
    }

    this.els.queueList.innerHTML = upcoming.map(function(track, i) {
      var actualIndex = self.currentIndex + 1 + i;
      return '<div class="queue-item" data-index="' + actualIndex + '">' +
        '<img src="' + escapeHtml(track.artwork || '/place-holder.webp') + '" alt="' + escapeHtml(track.title) + ' artwork" loading="lazy">' +
        '<div class="queue-item-info">' +
        '<p class="queue-item-title">' + escapeHtml(track.title) + '</p>' +
        '<p class="queue-item-artist">' + escapeHtml(track.artist) + '</p>' +
        '</div>' +
        '</div>';
    }).join('');

    // Add click handlers to queue items
    this.els.queueList.querySelectorAll('.queue-item').forEach(function(item) {
      (item as HTMLElement).onclick = function() {
        var index = parseInt(item.getAttribute('data-index') || '0');
        self.playFromQueue(index);
      };
    });
  },

  pauseGlobalPlayer: function() {
    try {
      var globalAudio = document.getElementById('global-audio') as HTMLAudioElement | null;
      if (globalAudio && !globalAudio.paused) {
        globalAudio.pause();
        var miniPlayIcon = document.getElementById('mini-play-icon');
        var miniPauseIcon = document.getElementById('mini-pause-icon');
        if (miniPlayIcon) miniPlayIcon.classList.remove('hidden');
        if (miniPauseIcon) miniPauseIcon.classList.add('hidden');
      }
    } catch (e){/* Best-effort — pausing global player is non-critical; UI state may be slightly stale */}
  },

  stopReleasePlateAudio: function() {
    document.querySelectorAll('.track-audio').forEach(function(audio) {
      if (!(audio as HTMLAudioElement).paused) {
        (audio as HTMLAudioElement).pause();
        (audio as HTMLAudioElement).currentTime = 0;
      }
    });
    document.querySelectorAll('.play-button').forEach(function(btn) {
      var playIcon = btn.querySelector('.play-icon');
      var pauseIcon = btn.querySelector('.pause-icon');
      if (playIcon) playIcon.classList.remove('hidden');
      if (pauseIcon) pauseIcon.classList.add('hidden');
    });
  },

  formatTime: function(seconds: number) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  },

  escapeHtml: function(text: string) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// Expose for external control
(window as Record<string, unknown>).ShufflePlayer = ShufflePlayer;

// Exported init function — called on each astro:page-load
export function init() {
  ShufflePlayer.init();
}
