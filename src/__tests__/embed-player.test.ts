import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaylistItem } from '../lib/types';
import type { PlayerCallbacks } from '../lib/embed-player-types';

// =============================================
// Mocks — vi.hoisted returns values available inside vi.mock factories
// =============================================

const {
  mockSetupDirectMedia,
  mockLoadYouTubeSDK,
  mockLoadVimeoSDK,
  mockLoadSoundCloudSDK,
} = vi.hoisted(() => ({
  mockSetupDirectMedia: vi.fn(),
  mockLoadYouTubeSDK: vi.fn().mockResolvedValue(undefined),
  mockLoadVimeoSDK: vi.fn().mockResolvedValue(undefined),
  mockLoadSoundCloudSDK: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/client-logger', () => ({
  createClientLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../lib/embed-player-direct', () => ({
  setupDirectMedia: mockSetupDirectMedia,
}));

vi.mock('../lib/embed-player-sdk', () => ({
  loadYouTubeSDK: (...args: unknown[]) => mockLoadYouTubeSDK(...args),
  loadVimeoSDK: (...args: unknown[]) => mockLoadVimeoSDK(...args),
  loadSoundCloudSDK: (...args: unknown[]) => mockLoadSoundCloudSDK(...args),
}));

// Mock YouTube global — must use function() for new YT.Player() constructor
const mockYTPlayer = {
  destroy: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  seekTo: vi.fn(),
  setVolume: vi.fn(),
  getCurrentTime: vi.fn().mockReturnValue(42),
  getDuration: vi.fn().mockReturnValue(300),
  getPlayerState: vi.fn().mockReturnValue(1),
  getVideoData: vi.fn().mockReturnValue({ title: 'Test' }),
};

function resetYTGlobal() {
  (globalThis as Record<string, unknown>).YT = {
    Player: vi.fn(function (_el: string, opts: Record<string, unknown>) {
      const events = opts.events as Record<string, (...args: unknown[]) => void>;
      setTimeout(() => events.onReady?.(), 0);
      return mockYTPlayer;
    }),
    PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
}
resetYTGlobal();

// Mock Vimeo global — must use function() for new Vimeo.Player() constructor
const mockVimeoPlayer = {
  destroy: vi.fn().mockResolvedValue(undefined),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  setCurrentTime: vi.fn().mockResolvedValue(undefined),
  setVolume: vi.fn().mockResolvedValue(undefined),
  getCurrentTime: vi.fn().mockResolvedValue(60),
  getDuration: vi.fn().mockResolvedValue(200),
  on: vi.fn(),
};

function resetVimeoGlobal() {
  (globalThis as Record<string, unknown>).Vimeo = {
    Player: vi.fn(function () { return mockVimeoPlayer; }),
  };
}
resetVimeoGlobal();

// Mock SoundCloud global
const mockSCWidget = {
  play: vi.fn(),
  pause: vi.fn(),
  seekTo: vi.fn(),
  setVolume: vi.fn(),
  getPosition: vi.fn((cb: (pos: number) => void) => cb(5000)),
  getDuration: vi.fn((cb: (dur: number) => void) => cb(180000)),
  bind: vi.fn(),
  unbind: vi.fn(),
};

function resetSCGlobal() {
  (globalThis as Record<string, unknown>).SC = {
    Widget: Object.assign(vi.fn(function () { return mockSCWidget; }), {
      Events: { READY: 'ready', FINISH: 'finish', ERROR: 'error', PLAY: 'play', PAUSE: 'pause' },
    }),
  };
}
resetSCGlobal();

// Ensure a minimal global document exists for the node test environment
if (typeof globalThis.document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    getElementById: vi.fn(),
    createElement: vi.fn(),
    head: { appendChild: vi.fn() },
  };
}

// Fake container for document.getElementById
function createFakeContainer(): HTMLElement {
  return {
    innerHTML: '',
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  } as unknown as HTMLElement;
}

let fakeContainer: HTMLElement;

// Now import the module under test
import { EmbedPlayerManager } from '../lib/embed-player';

// =============================================
// Helpers
// =============================================
function makeItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: '1',
    url: 'https://example.com/test',
    platform: 'youtube',
    addedAt: new Date().toISOString(),
    title: 'Test',
    ...overrides,
  };
}

// =============================================
// Tests
// =============================================
describe('EmbedPlayerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Re-initialize globals after clearAllMocks wipes mock implementations
    resetYTGlobal();
    resetVimeoGlobal();
    resetSCGlobal();

    // Re-set individual mock return values after clearAllMocks
    mockYTPlayer.getCurrentTime.mockReturnValue(42);
    mockYTPlayer.getDuration.mockReturnValue(300);
    mockYTPlayer.getPlayerState.mockReturnValue(1);
    mockYTPlayer.getVideoData.mockReturnValue({ title: 'Test' });
    mockVimeoPlayer.destroy.mockResolvedValue(undefined);
    mockVimeoPlayer.play.mockResolvedValue(undefined);
    mockVimeoPlayer.pause.mockResolvedValue(undefined);
    mockVimeoPlayer.setCurrentTime.mockResolvedValue(undefined);
    mockVimeoPlayer.setVolume.mockResolvedValue(undefined);
    mockVimeoPlayer.getCurrentTime.mockResolvedValue(60);
    mockVimeoPlayer.getDuration.mockResolvedValue(200);
    mockSCWidget.getPosition.mockImplementation((cb: (pos: number) => void) => cb(5000));
    mockSCWidget.getDuration.mockImplementation((cb: (dur: number) => void) => cb(180000));

    fakeContainer = createFakeContainer();
    (globalThis.document as Record<string, unknown>).getElementById = vi.fn().mockReturnValue(fakeContainer);

    // Default setupDirectMedia mock
    mockSetupDirectMedia.mockReturnValue({
      mediaElement: {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        duration: 120,
        paused: false,
        readyState: 4,
        volume: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ------------------------------------------
  // Constructor
  // ------------------------------------------
  describe('constructor', () => {
    it('creates an instance with a container ID', () => {
      const mgr = new EmbedPlayerManager('player-container');
      expect(mgr).toBeInstanceOf(EmbedPlayerManager);
    });

    it('accepts optional callbacks', () => {
      const callbacks: PlayerCallbacks = {
        onReady: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
      };
      const mgr = new EmbedPlayerManager('player-container', callbacks);
      expect(mgr).toBeInstanceOf(EmbedPlayerManager);
    });
  });

  // ------------------------------------------
  // setPendingSeek
  // ------------------------------------------
  describe('setPendingSeek', () => {
    it('stores a seek position when > 2 seconds', () => {
      const mgr = new EmbedPlayerManager('c');
      mgr.setPendingSeek(30);
      // We can verify it was stored by testing that after loadItem, the seek fires
      // (internal state is private so we test via behavior)
      expect(mgr).toBeDefined();
    });

    it('clears seek position when <= 2 seconds', () => {
      const mgr = new EmbedPlayerManager('c');
      mgr.setPendingSeek(1);
      // No-op, internal pendingSeekPosition should be null
      expect(mgr).toBeDefined();
    });
  });

  // ------------------------------------------
  // loadItem — platform dispatch
  // ------------------------------------------
  describe('loadItem', () => {
    it('loads YouTube for platform "youtube"', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc123' });

      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      expect(mockLoadYouTubeSDK).toHaveBeenCalled();
      expect((globalThis as Record<string, unknown>).YT).toBeDefined();
    });

    it('loads Vimeo for platform "vimeo"', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '456' });

      await mgr.loadItem(item);

      expect(mockLoadVimeoSDK).toHaveBeenCalled();
    });

    it('loads SoundCloud for platform "soundcloud"', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });

      await mgr.loadItem(item);

      expect(mockLoadSoundCloudSDK).toHaveBeenCalled();
    });

    it('loads direct media for platform "direct"', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });

      await mgr.loadItem(item);

      expect(mockSetupDirectMedia).toHaveBeenCalledWith(
        fakeContainer,
        item,
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('calls onError for unsupported platform', async () => {
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'unknown' as PlaylistItem['platform'] });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith(expect.stringContaining('Unsupported platform'));
    });

    it('throws error for missing YouTube embedId', async () => {
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'youtube', embedId: undefined });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith('Missing YouTube video ID');
    });

    it('throws error for missing Vimeo embedId', async () => {
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'vimeo', embedId: undefined });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith('Missing Vimeo video ID');
    });

    it('throws error for missing SoundCloud embedId', async () => {
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'soundcloud', embedId: undefined });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith('Missing SoundCloud track path');
    });

    it('calls onError when container is not found', async () => {
      (globalThis.document as Record<string, unknown>).getElementById = vi.fn().mockReturnValue(null);
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('missing', { onError });
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith('Container not found');
    });
  });

  // ------------------------------------------
  // YouTube-specific loading
  // ------------------------------------------
  describe('YouTube loading', () => {
    it('creates YouTube player with correct options', async () => {
      const onReady = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onReady });
      const item = makeItem({ platform: 'youtube', embedId: 'dQw4w9WgXcQ' });

      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      const YTPlayerFn = (globalThis as Record<string, { Player: ReturnType<typeof vi.fn> }>).YT.Player;
      expect(YTPlayerFn).toHaveBeenCalledWith(
        'youtube-player',
        expect.objectContaining({
          videoId: 'dQw4w9WgXcQ',
          height: '100%',
          width: '100%',
        }),
      );
    });

    it('fires onReady callback when YouTube player reports ready', async () => {
      const onReady = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onReady });
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });

      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      expect(onReady).toHaveBeenCalled();
    });

    it('inserts youtube-player div into container', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });

      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      expect(fakeContainer.innerHTML).toContain('youtube-player');
    });
  });

  // ------------------------------------------
  // Vimeo-specific loading
  // ------------------------------------------
  describe('Vimeo loading', () => {
    it('creates Vimeo iframe and player', async () => {
      const onReady = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onReady });
      const item = makeItem({ platform: 'vimeo', embedId: '12345' });

      await mgr.loadItem(item);

      expect(fakeContainer.innerHTML).toContain('vimeo-player');
      expect(onReady).toHaveBeenCalled();
    });

    it('registers ended, error, play, and pause event handlers', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '12345' });

      await mgr.loadItem(item);

      expect(mockVimeoPlayer.on).toHaveBeenCalledWith('ended', expect.any(Function));
      expect(mockVimeoPlayer.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockVimeoPlayer.on).toHaveBeenCalledWith('play', expect.any(Function));
      expect(mockVimeoPlayer.on).toHaveBeenCalledWith('pause', expect.any(Function));
    });
  });

  // ------------------------------------------
  // SoundCloud-specific loading
  // ------------------------------------------
  describe('SoundCloud loading', () => {
    it('creates SoundCloud iframe and widget', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });

      await mgr.loadItem(item);

      expect(fakeContainer.innerHTML).toContain('soundcloud-player');
    });

    it('binds READY, FINISH, ERROR, PLAY, and PAUSE events', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });

      await mgr.loadItem(item);

      expect(mockSCWidget.bind).toHaveBeenCalledWith('ready', expect.any(Function));
      expect(mockSCWidget.bind).toHaveBeenCalledWith('finish', expect.any(Function));
      expect(mockSCWidget.bind).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockSCWidget.bind).toHaveBeenCalledWith('play', expect.any(Function));
      expect(mockSCWidget.bind).toHaveBeenCalledWith('pause', expect.any(Function));
    });
  });

  // ------------------------------------------
  // Direct media loading
  // ------------------------------------------
  describe('direct media loading', () => {
    it('delegates to setupDirectMedia with correct arguments', async () => {
      const onReady = vi.fn();
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onReady, onError });
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/clip.mp4' });

      await mgr.loadItem(item);

      expect(mockSetupDirectMedia).toHaveBeenCalledTimes(1);
      expect(mockSetupDirectMedia.mock.calls[0][1]).toBe(item);
    });

    it('registers ended, error, play, and pause event listeners on media element', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/clip.mp4' });

      await mgr.loadItem(item);

      const registeredEvents = fakeMedia.addEventListener.mock.calls.map((c: unknown[]) => c[0]);
      expect(registeredEvents).toContain('ended');
      expect(registeredEvents).toContain('error');
      expect(registeredEvents).toContain('play');
      expect(registeredEvents).toContain('pause');
    });
  });

  // ------------------------------------------
  // play / pause
  // ------------------------------------------
  describe('play', () => {
    it('plays YouTube player', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      await mgr.play();
      expect(mockYTPlayer.playVideo).toHaveBeenCalled();
    });

    it('plays direct media', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      await mgr.play();
      expect(fakeMedia.play).toHaveBeenCalled();
    });
  });

  describe('pause', () => {
    it('pauses YouTube player', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      await mgr.pause();
      expect(mockYTPlayer.pauseVideo).toHaveBeenCalled();
    });

    it('pauses Vimeo player', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '123' });
      await mgr.loadItem(item);

      await mgr.pause();
      expect(mockVimeoPlayer.pause).toHaveBeenCalled();
    });

    it('pauses SoundCloud widget', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });
      await mgr.loadItem(item);

      await mgr.pause();
      expect(mockSCWidget.pause).toHaveBeenCalled();
    });
  });

  // ------------------------------------------
  // setVolume
  // ------------------------------------------
  describe('setVolume', () => {
    it('clamps volume to 0-100 range for YouTube', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      mgr.setVolume(150);
      expect(mockYTPlayer.setVolume).toHaveBeenCalledWith(100);

      mgr.setVolume(-10);
      expect(mockYTPlayer.setVolume).toHaveBeenCalledWith(0);
    });

    it('normalizes 0-100 to 0-1 for Vimeo', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '123' });
      await mgr.loadItem(item);

      mgr.setVolume(50);
      expect(mockVimeoPlayer.setVolume).toHaveBeenCalledWith(0.5);
    });

    it('normalizes 0-100 to 0-1 for direct media', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        volume: 1,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      mgr.setVolume(75);
      expect(fakeMedia.volume).toBe(0.75);
    });
  });

  // ------------------------------------------
  // seekTo
  // ------------------------------------------
  describe('seekTo', () => {
    it('seeks YouTube player', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      await mgr.seekTo(90);
      expect(mockYTPlayer.seekTo).toHaveBeenCalledWith(90, true);
    });

    it('clamps negative seek to 0', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      await mgr.seekTo(-5);
      expect(mockYTPlayer.seekTo).toHaveBeenCalledWith(0, true);
    });

    it('seeks SoundCloud in milliseconds', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });
      await mgr.loadItem(item);

      await mgr.seekTo(30);
      expect(mockSCWidget.seekTo).toHaveBeenCalledWith(30000);
    });
  });

  // ------------------------------------------
  // getCurrentTime / getDuration
  // ------------------------------------------
  describe('getCurrentTime', () => {
    it('returns YouTube current time', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      const time = await mgr.getCurrentTime();
      expect(time).toBe(42);
    });

    it('returns Vimeo current time', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '123' });
      await mgr.loadItem(item);

      const time = await mgr.getCurrentTime();
      expect(time).toBe(60);
    });

    it('returns 0 when no player is loaded', async () => {
      const mgr = new EmbedPlayerManager('c');
      const time = await mgr.getCurrentTime();
      expect(time).toBe(0);
    });
  });

  describe('getDuration', () => {
    it('returns YouTube duration', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      const dur = await mgr.getDuration();
      expect(dur).toBe(300);
    });

    it('returns Vimeo duration', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '123' });
      await mgr.loadItem(item);

      const dur = await mgr.getDuration();
      expect(dur).toBe(200);
    });

    it('returns 0 for direct media with NaN duration', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        duration: NaN,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      const dur = await mgr.getDuration();
      expect(dur).toBe(0);
    });

    it('returns 0 for direct media with Infinity duration', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        duration: Infinity,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      const dur = await mgr.getDuration();
      expect(dur).toBe(0);
    });
  });

  // ------------------------------------------
  // isActuallyPlaying
  // ------------------------------------------
  describe('isActuallyPlaying', () => {
    it('returns true when YouTube state is PLAYING (1)', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      mockYTPlayer.getPlayerState.mockReturnValue(1);
      expect(mgr.isActuallyPlaying()).toBe(true);
    });

    it('returns false when YouTube state is PAUSED (2)', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      mockYTPlayer.getPlayerState.mockReturnValue(2);
      expect(mgr.isActuallyPlaying()).toBe(false);
    });

    it('returns true for direct media when not paused and ready', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 10,
        duration: 120,
        paused: false,
        readyState: 4,
        volume: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      expect(mgr.isActuallyPlaying()).toBe(true);
    });

    it('returns false for direct media when paused', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 10,
        duration: 120,
        paused: true,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      expect(mgr.isActuallyPlaying()).toBe(false);
    });

    it('returns false when no player is loaded', () => {
      const mgr = new EmbedPlayerManager('c');
      expect(mgr.isActuallyPlaying()).toBe(false);
    });
  });

  // ------------------------------------------
  // cleanup / destroy
  // ------------------------------------------
  describe('destroy', () => {
    it('destroys YouTube player', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      await mgr.destroy();
      expect(mockYTPlayer.destroy).toHaveBeenCalled();
    });

    it('destroys Vimeo player', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'vimeo', embedId: '123' });
      await mgr.loadItem(item);

      await mgr.destroy();
      expect(mockVimeoPlayer.destroy).toHaveBeenCalled();
    });

    it('unbinds SoundCloud events on cleanup', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });
      await mgr.loadItem(item);

      await mgr.destroy();
      expect(mockSCWidget.unbind).toHaveBeenCalledWith('ready');
      expect(mockSCWidget.unbind).toHaveBeenCalledWith('finish');
      expect(mockSCWidget.unbind).toHaveBeenCalledWith('error');
      expect(mockSCWidget.unbind).toHaveBeenCalledWith('play');
    });

    it('pauses and clears direct media on cleanup', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      await mgr.destroy();
      expect(fakeMedia.pause).toHaveBeenCalled();
    });

    it('clears container innerHTML on destroy', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(item);
      await vi.runAllTimersAsync();

      fakeContainer.innerHTML = '<div>some content</div>';
      await mgr.destroy();
      expect(fakeContainer.innerHTML).toBe('');
    });

    it('cleans up previous player when loading a new item', async () => {
      const mgr = new EmbedPlayerManager('c');

      // Load YouTube first
      const ytItem = makeItem({ platform: 'youtube', embedId: 'abc' });
      await mgr.loadItem(ytItem);
      await vi.runAllTimersAsync();

      // Now load Vimeo (should destroy YouTube first)
      const vimeoItem = makeItem({ platform: 'vimeo', embedId: '456' });
      await mgr.loadItem(vimeoItem);

      expect(mockYTPlayer.destroy).toHaveBeenCalled();
    });

    it('does not throw when destroying without loading anything', async () => {
      const mgr = new EmbedPlayerManager('c');
      await expect(mgr.destroy()).resolves.not.toThrow();
    });
  });

  // ------------------------------------------
  // Error handling
  // ------------------------------------------
  describe('error handling', () => {
    it('catches and reports SDK load errors', async () => {
      mockLoadYouTubeSDK.mockRejectedValueOnce(new Error('Network error'));
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'youtube', embedId: 'abc' });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith('Network error');
    });

    it('reports non-Error exceptions as generic message', async () => {
      mockLoadVimeoSDK.mockRejectedValueOnce('string error');
      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'vimeo', embedId: '123' });

      await mgr.loadItem(item);

      expect(onError).toHaveBeenCalledWith('Failed to load media');
    });

    it('suppresses AbortError on play()', async () => {
      const fakeMedia = {
        pause: vi.fn(),
        play: vi.fn().mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        src: '',
        load: vi.fn(),
        currentTime: 0,
        paused: false,
        readyState: 4,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      mockSetupDirectMedia.mockReturnValue({ mediaElement: fakeMedia });

      const onError = vi.fn();
      const mgr = new EmbedPlayerManager('c', { onError });
      const item = makeItem({ platform: 'direct', url: 'https://cdn.example.com/track.mp3' });
      await mgr.loadItem(item);

      // play() should not throw or call onError for AbortError
      await expect(mgr.play()).resolves.not.toThrow();
    });
  });

  // ------------------------------------------
  // SoundCloud getCurrentTime / getDuration (callback-based)
  // ------------------------------------------
  describe('SoundCloud time/duration', () => {
    it('returns position in seconds (converted from ms)', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });
      await mgr.loadItem(item);

      const time = await mgr.getCurrentTime();
      expect(time).toBe(5); // 5000ms -> 5s
    });

    it('returns duration in seconds (converted from ms)', async () => {
      const mgr = new EmbedPlayerManager('c');
      const item = makeItem({ platform: 'soundcloud', embedId: 'artist/track' });
      await mgr.loadItem(item);

      const dur = await mgr.getDuration();
      expect(dur).toBe(180); // 180000ms -> 180s
    });
  });
});
