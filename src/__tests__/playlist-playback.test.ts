import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlaylistContext } from '../lib/playlist/types';
import type { GlobalPlaylistItem, GlobalPlaylist } from '../lib/types';
import { MAX_CONSECUTIVE_ERRORS } from '../lib/constants/limits';
import {
  MAX_TRACK_DURATION_MS,
} from '../lib/playlist-manager/types';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above imports from playback.ts
// ---------------------------------------------------------------------------

// Mock client-logger (used internally by playback.ts)
vi.mock('../lib/client-logger', () => ({
  createClientLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock playlist-manager/history (saveRecentlyPlayedToStorage)
vi.mock('../lib/playlist-manager/history', () => ({
  saveRecentlyPlayedToStorage: vi.fn(),
}));

// Mock playlist-manager/metadata (isPlaceholderTitle)
vi.mock('../lib/playlist-manager/metadata', () => ({
  isPlaceholderTitle: (title?: string) => !title || /^Track \d+$/i.test(title),
}));

// Mock playlist-manager/ui (DOM operations)
vi.mock('../lib/playlist-manager/ui', () => ({
  enableEmojis: vi.fn(),
  disableEmojis: vi.fn(),
  stopPlaylistMeters: vi.fn(),
  startCountdown: vi.fn(() => 123),
  startElapsedTimer: vi.fn(() => 456),
  updateNowPlayingDisplay: vi.fn(),
  showVideoPlayer: vi.fn(),
  hidePlaylistLoadingOverlay: vi.fn(),
  showOfflineOverlay: vi.fn(),
}));

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock window globals — use a proxy so that window.setTimeout always resolves
// to the current globalThis.setTimeout (which vi.useFakeTimers patches).
const windowMock: Record<string, unknown> = {
  isLiveStreamActive: false,
  dispatchEvent: vi.fn(),
  CustomEvent: class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, opts?: { detail?: unknown }) {
      this.type = type;
      this.detail = opts?.detail;
    }
  },
};
const windowProxy = new Proxy(windowMock, {
  get(target, prop) {
    if (prop === 'setTimeout') return globalThis.setTimeout;
    if (prop === 'clearTimeout') return globalThis.clearTimeout;
    return target[prop as string];
  },
  set(target, prop, value) {
    target[prop as string] = value;
    return true;
  },
});
vi.stubGlobal('window', windowProxy);

// Mock document.getElementById
vi.stubGlobal('document', {
  getElementById: vi.fn(() => ({ id: 'player-container' })),
});

// Import after mocks
import {
  markAsPlayed,
  startTrackTimer,
  clearTrackTimer,
  calculateSyncPosition,
  handleTrackEnded,
  handlePlaybackError,
  handlePlayerReady,
  handleStateChange,
  handleTitleUpdate,
  clearQueue,
  stopCountdown,
} from '../lib/playlist/playback';
import { saveRecentlyPlayedToStorage } from '../lib/playlist-manager/history';
import {
  disableEmojis,
  updateNowPlayingDisplay,
  showOfflineOverlay,
  hidePlaylistLoadingOverlay,
} from '../lib/playlist-manager/ui';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<GlobalPlaylistItem> = {}): GlobalPlaylistItem {
  return {
    id: 'item-1',
    url: 'https://youtube.com/watch?v=abc123',
    platform: 'youtube',
    embedId: 'abc123',
    title: 'Test Track',
    thumbnail: 'https://img.youtube.com/vi/abc123/mqdefault.jpg',
    addedAt: new Date().toISOString(),
    addedBy: 'user1',
    addedByName: 'DJ Test',
    ...overrides,
  };
}

function makePlaylist(overrides: Partial<GlobalPlaylist> = {}): GlobalPlaylist {
  return {
    queue: [makeItem()],
    currentIndex: 0,
    isPlaying: true,
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PlaylistContext> = {}): PlaylistContext {
  return {
    containerId: 'player-container',
    userId: 'user1',
    userName: 'DJ Test',
    isAuthenticated: true,
    playlist: makePlaylist(),
    player: null,
    playerPromise: null,
    trackTimer: null,
    recentlyPlayed: new Map(),
    globalRecentlyPlayed: [],
    countdownInterval: null,
    countdownTrackId: null,
    isFetchingDuration: false,
    consecutiveErrors: 0,
    lastPlayedUrl: null,
    isPlayingLocked: false,
    pendingPlayRequest: false,
    isPausedLocally: false,
    playbackStartedTime: 0,
    playHistory: [],
    personalPlaylist: [],
    isSubscribed: false,
    pusherChannel: null,
    wasPausedForStream: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  fetchMock.mockReset();
  (document.getElementById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'player-container' });
  windowMock.isLiveStreamActive = false;
});

// =============================================
// markAsPlayed
// =============================================
describe('markAsPlayed', () => {
  it('sets lastPlayedUrl on context', () => {
    const ctx = makeCtx();
    markAsPlayed(ctx, 'https://youtube.com/watch?v=xyz');
    expect(ctx.lastPlayedUrl).toBe('https://youtube.com/watch?v=xyz');
  });

  it('adds URL to recentlyPlayed map with current timestamp', () => {
    const ctx = makeCtx();
    const before = Date.now();
    markAsPlayed(ctx, 'https://youtube.com/watch?v=xyz');
    const after = Date.now();
    const ts = ctx.recentlyPlayed.get('https://youtube.com/watch?v=xyz');
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('calls saveRecentlyPlayedToStorage', () => {
    const ctx = makeCtx();
    markAsPlayed(ctx, 'https://youtube.com/watch?v=xyz');
    expect(saveRecentlyPlayedToStorage).toHaveBeenCalledWith(ctx.recentlyPlayed);
  });
});

// =============================================
// startTrackTimer / clearTrackTimer
// =============================================
describe('startTrackTimer / clearTrackTimer', () => {
  it('sets a timer on ctx.trackTimer', () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const onEnded = vi.fn();
    startTrackTimer(ctx, onEnded);
    expect(ctx.trackTimer).not.toBeNull();
    vi.useRealTimers();
  });

  it('calls onTrackEnded when timer fires', () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const onEnded = vi.fn();
    startTrackTimer(ctx, onEnded);
    vi.advanceTimersByTime(MAX_TRACK_DURATION_MS);
    expect(onEnded).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('clearTrackTimer cancels the timer', () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const onEnded = vi.fn();
    startTrackTimer(ctx, onEnded);
    clearTrackTimer(ctx);
    expect(ctx.trackTimer).toBeNull();
    vi.advanceTimersByTime(MAX_TRACK_DURATION_MS);
    expect(onEnded).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('startTrackTimer clears existing timer before setting new one', () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const onEnded1 = vi.fn();
    const onEnded2 = vi.fn();
    startTrackTimer(ctx, onEnded1);
    startTrackTimer(ctx, onEnded2);
    vi.advanceTimersByTime(MAX_TRACK_DURATION_MS);
    expect(onEnded1).not.toHaveBeenCalled();
    expect(onEnded2).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// =============================================
// calculateSyncPosition
// =============================================
describe('calculateSyncPosition', () => {
  it('returns 0 when no trackStartedAt', () => {
    const ctx = makeCtx({ playlist: makePlaylist({ trackStartedAt: undefined }) });
    expect(calculateSyncPosition(ctx)).toBe(0);
  });

  it('returns 0 when trackStartedAt is null', () => {
    const ctx = makeCtx({ playlist: makePlaylist({ trackStartedAt: null as unknown as string }) });
    expect(calculateSyncPosition(ctx)).toBe(0);
  });

  it('returns elapsed seconds for a recent track start', () => {
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const ctx = makeCtx({ playlist: makePlaylist({ trackStartedAt: fiveSecondsAgo }) });
    const pos = calculateSyncPosition(ctx);
    // Allow 1 second tolerance for test execution time
    expect(pos).toBeGreaterThanOrEqual(4);
    expect(pos).toBeLessThanOrEqual(6);
  });

  it('caps position at max track duration', () => {
    const longAgo = new Date(Date.now() - (MAX_TRACK_DURATION_MS * 2)).toISOString();
    const ctx = makeCtx({ playlist: makePlaylist({ trackStartedAt: longAgo }) });
    const pos = calculateSyncPosition(ctx);
    expect(pos).toBe(MAX_TRACK_DURATION_MS / 1000);
  });

  it('returns 0 for future trackStartedAt', () => {
    const futureDate = new Date(Date.now() + 10000).toISOString();
    const ctx = makeCtx({ playlist: makePlaylist({ trackStartedAt: futureDate }) });
    const pos = calculateSyncPosition(ctx);
    expect(pos).toBe(0);
  });
});

// =============================================
// handlePlayerReady
// =============================================
describe('handlePlayerReady', () => {
  it('resets consecutiveErrors to 0', () => {
    const ctx = makeCtx({ consecutiveErrors: 5 });
    handlePlayerReady(ctx);
    expect(ctx.consecutiveErrors).toBe(0);
  });

  it('works when consecutiveErrors is already 0', () => {
    const ctx = makeCtx({ consecutiveErrors: 0 });
    handlePlayerReady(ctx);
    expect(ctx.consecutiveErrors).toBe(0);
  });
});

// =============================================
// handlePlaybackError
// =============================================
describe('handlePlaybackError', () => {
  it('increments consecutiveErrors on regular error', async () => {
    const ctx = makeCtx({ consecutiveErrors: 0 });
    const handleTrackEndedFn = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handlePlaybackError(ctx, 'some error', handleTrackEndedFn, renderUI);

    expect(ctx.consecutiveErrors).toBe(1);
    expect(handleTrackEndedFn).toHaveBeenCalledTimes(1);
  });

  it('stops playback when max consecutive errors reached', async () => {
    const ctx = makeCtx({ consecutiveErrors: MAX_CONSECUTIVE_ERRORS - 1 });
    const handleTrackEndedFn = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handlePlaybackError(ctx, 'another error', handleTrackEndedFn, renderUI);

    expect(ctx.consecutiveErrors).toBe(0);
    expect(ctx.playlist.isPlaying).toBe(false);
    expect(renderUI).toHaveBeenCalledTimes(1);
    expect(handleTrackEndedFn).not.toHaveBeenCalled();
  });

  it('resets errors and stops playback at exactly MAX_CONSECUTIVE_ERRORS', async () => {
    const ctx = makeCtx({ consecutiveErrors: MAX_CONSECUTIVE_ERRORS - 1 });
    const handleTrackEndedFn = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handlePlaybackError(ctx, 'error', handleTrackEndedFn, renderUI);

    expect(ctx.consecutiveErrors).toBe(0);
    expect(ctx.playlist.isPlaying).toBe(false);
  });

  it('skips track on blocked video error', async () => {
    const ctx = makeCtx();
    const handleTrackEndedFn = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    // Mock the markVideoAsBlocked fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const blockedError = JSON.stringify({ type: 'blocked', message: 'Video unavailable' });
    await handlePlaybackError(ctx, blockedError, handleTrackEndedFn, renderUI);

    expect(handleTrackEndedFn).toHaveBeenCalledTimes(1);
    // consecutiveErrors should NOT be incremented for blocked videos
    expect(ctx.consecutiveErrors).toBe(0);
  });

  it('returns early when container not found', async () => {
    (document.getElementById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const ctx = makeCtx({ consecutiveErrors: 5 });
    const handleTrackEndedFn = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handlePlaybackError(ctx, 'error', handleTrackEndedFn, renderUI);

    expect(ctx.consecutiveErrors).toBe(0);
    expect(handleTrackEndedFn).not.toHaveBeenCalled();
    expect(renderUI).not.toHaveBeenCalled();
  });

  it('handles non-JSON error string gracefully', async () => {
    const ctx = makeCtx({ consecutiveErrors: 0 });
    const handleTrackEndedFn = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handlePlaybackError(ctx, 'plain text error', handleTrackEndedFn, renderUI);

    expect(ctx.consecutiveErrors).toBe(1);
    expect(handleTrackEndedFn).toHaveBeenCalledTimes(1);
  });
});

// =============================================
// handleStateChange
// =============================================
describe('handleStateChange', () => {
  it('sets isPlaying true and records playbackStartedTime on playing state', () => {
    const ctx = makeCtx({ playlist: makePlaylist({ isPlaying: false }), playbackStartedTime: 0 });
    const renderUI = vi.fn();
    const before = Date.now();

    handleStateChange(ctx, 'playing', renderUI);

    expect(ctx.playlist.isPlaying).toBe(true);
    expect(ctx.playbackStartedTime).toBeGreaterThanOrEqual(before);
    expect(renderUI).toHaveBeenCalledTimes(1);
    expect(hidePlaylistLoadingOverlay).toHaveBeenCalled();
  });

  it('sets isPlaying false on paused state', () => {
    const ctx = makeCtx({ playlist: makePlaylist({ isPlaying: true }) });
    const renderUI = vi.fn();

    handleStateChange(ctx, 'paused', renderUI);

    expect(ctx.playlist.isPlaying).toBe(false);
    expect(renderUI).toHaveBeenCalledTimes(1);
  });

  it('does not change state for unknown state string', () => {
    const ctx = makeCtx({ playlist: makePlaylist({ isPlaying: true }) });
    const renderUI = vi.fn();

    handleStateChange(ctx, 'buffering', renderUI);

    expect(ctx.playlist.isPlaying).toBe(true);
    expect(renderUI).not.toHaveBeenCalled();
  });
});

// =============================================
// handleTitleUpdate
// =============================================
describe('handleTitleUpdate', () => {
  it('updates title when current item has placeholder title', () => {
    const item = makeItem({ title: 'Track 12345' });
    const ctx = makeCtx({ playlist: makePlaylist({ queue: [item] }) });
    const renderUI = vi.fn();

    handleTitleUpdate(ctx, 'Real Song Title', renderUI);

    expect(ctx.playlist.queue[0].title).toBe('Real Song Title');
    expect(renderUI).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite non-placeholder title', () => {
    const item = makeItem({ title: 'Good Title' });
    const ctx = makeCtx({ playlist: makePlaylist({ queue: [item] }) });
    const renderUI = vi.fn();

    handleTitleUpdate(ctx, 'New Title', renderUI);

    expect(ctx.playlist.queue[0].title).toBe('Good Title');
    expect(renderUI).not.toHaveBeenCalled();
  });

  it('updates title when current item has no title', () => {
    const item = makeItem({ title: undefined });
    const ctx = makeCtx({ playlist: makePlaylist({ queue: [item] }) });
    const renderUI = vi.fn();

    handleTitleUpdate(ctx, 'Fetched Title', renderUI);

    expect(ctx.playlist.queue[0].title).toBe('Fetched Title');
    expect(renderUI).toHaveBeenCalledTimes(1);
  });

  it('does nothing when queue is empty', () => {
    const ctx = makeCtx({ playlist: makePlaylist({ queue: [], currentIndex: 0 }) });
    const renderUI = vi.fn();

    handleTitleUpdate(ctx, 'Title', renderUI);

    expect(renderUI).not.toHaveBeenCalled();
  });
});

// =============================================
// handleTrackEnded
// =============================================
describe('handleTrackEnded', () => {
  it('calls server trackEnded endpoint and plays next track', async () => {
    const newPlaylist = makePlaylist({
      queue: [makeItem({ id: 'item-2' })],
      currentIndex: 0,
      isPlaying: true,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, playlist: newPlaylist }),
    });

    const ctx = makeCtx();
    const playCurrent = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handleTrackEnded(ctx, playCurrent, renderUI);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/playlist/global/',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(playCurrent).toHaveBeenCalledTimes(1);
    expect(renderUI).toHaveBeenCalled();
  });

  it('shows offline overlay when server returns empty queue', async () => {
    const emptyPlaylist = makePlaylist({ queue: [], isPlaying: false });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, playlist: emptyPlaylist }),
      })
      // retry fetch (the 10s setTimeout)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, playlist: emptyPlaylist }),
      });

    const ctx = makeCtx();
    const playCurrent = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handleTrackEnded(ctx, playCurrent, renderUI);

    expect(disableEmojis).toHaveBeenCalled();
    expect(updateNowPlayingDisplay).toHaveBeenCalledWith(null);
    expect(showOfflineOverlay).toHaveBeenCalled();
    expect(playCurrent).not.toHaveBeenCalled();
  });

  it('clears timers before processing', async () => {
    const ctx = makeCtx({ trackTimer: 999, countdownInterval: 888 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, playlist: makePlaylist() }),
    });
    const playCurrent = vi.fn().mockResolvedValue(undefined);
    const renderUI = vi.fn();

    await handleTrackEnded(ctx, playCurrent, renderUI);

    expect(ctx.trackTimer).toBeNull();
  });

  it('returns early when queue is empty (no current item)', async () => {
    const ctx = makeCtx({ playlist: makePlaylist({ queue: [], currentIndex: 0 }) });
    const playCurrent = vi.fn();
    const renderUI = vi.fn();

    await handleTrackEnded(ctx, playCurrent, renderUI);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(playCurrent).not.toHaveBeenCalled();
  });

  it('handles network error gracefully', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network failure'));

    const ctx = makeCtx();
    const destroyMock = vi.fn();
    ctx.player = { destroy: destroyMock } as unknown as PlaylistContext['player'];
    const playCurrent = vi.fn();
    const renderUI = vi.fn();

    await handleTrackEnded(ctx, playCurrent, renderUI);

    expect(ctx.playlist.isPlaying).toBe(false);
    expect(disableEmojis).toHaveBeenCalled();
    expect(showOfflineOverlay).toHaveBeenCalled();
    expect(renderUI).toHaveBeenCalled();
  });
});

// =============================================
// clearQueue
// =============================================
describe('clearQueue', () => {
  it('empties the queue and resets state', async () => {
    const ctx = makeCtx({
      playlist: makePlaylist({
        queue: [makeItem(), makeItem({ id: 'item-2' })],
        currentIndex: 1,
        isPlaying: true,
      }),
    });
    const renderUI = vi.fn();

    await clearQueue(ctx, renderUI);

    expect(ctx.playlist.queue).toEqual([]);
    expect(ctx.playlist.currentIndex).toBe(0);
    expect(ctx.playlist.isPlaying).toBe(false);
    expect(disableEmojis).toHaveBeenCalled();
    expect(updateNowPlayingDisplay).toHaveBeenCalledWith(null);
    expect(showOfflineOverlay).toHaveBeenCalled();
    expect(renderUI).toHaveBeenCalledTimes(1);
  });

  it('destroys player if it exists', async () => {
    const destroyMock = vi.fn();
    const ctx = makeCtx();
    ctx.player = { destroy: destroyMock } as unknown as PlaylistContext['player'];
    const renderUI = vi.fn();

    await clearQueue(ctx, renderUI);

    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================
// stopCountdown
// =============================================
describe('stopCountdown', () => {
  it('clears interval and resets countdownTrackId', () => {
    vi.useFakeTimers();
    const intervalId = setInterval(() => {}, 1000) as unknown as number;
    const ctx = makeCtx({ countdownInterval: intervalId, countdownTrackId: 'track-1' });

    stopCountdown(ctx);

    expect(ctx.countdownInterval).toBeNull();
    expect(ctx.countdownTrackId).toBeNull();
    vi.useRealTimers();
  });

  it('does nothing when no interval is set', () => {
    const ctx = makeCtx({ countdownInterval: null, countdownTrackId: null });

    stopCountdown(ctx);

    expect(ctx.countdownInterval).toBeNull();
    expect(ctx.countdownTrackId).toBeNull();
  });
});
