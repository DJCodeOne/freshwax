import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlaylistItem } from '../lib/types';

// Mock client-logger before importing module under test
vi.mock('../lib/client-logger', () => ({
  createClientLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Minimal mock for Hls global (used in HLS branch)
const hlsMock = {
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
  on: vi.fn(),
};

// Set up global Hls before import — must use function() not arrow for new Hls() constructor
(globalThis as Record<string, unknown>).Hls = Object.assign(
  vi.fn(function () { return hlsMock; }),
  {
    isSupported: vi.fn(() => true),
    Events: { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' },
  },
);

// Ensure a minimal global document exists for the node test environment
if (typeof globalThis.document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    getElementById: vi.fn(),
    createElement: vi.fn(),
    head: { appendChild: vi.fn() },
  };
}

import { buildAudioPlayerHTML, setupDirectMedia } from '../lib/embed-player-direct';

// =============================================
// Helper to make a PlaylistItem
// =============================================
function makeItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: '1',
    url: 'https://example.com/track.mp3',
    platform: 'direct',
    addedAt: new Date().toISOString(),
    title: 'Test Track',
    thumbnail: 'https://example.com/thumb.jpg',
    ...overrides,
  };
}

// =============================================
// Minimal fake elements for node test env
// =============================================
function createFakeMediaElement(tag: 'audio' | 'video'): Record<string, unknown> {
  return {
    tagName: tag.toUpperCase(),
    src: '',
    autoplay: false,
    style: {},
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    load: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    canPlayType: vi.fn().mockReturnValue(''),
  };
}

function createFakeContainer(): { el: HTMLElement; childMap: Map<string, Record<string, unknown>> } {
  const childMap = new Map<string, Record<string, unknown>>();
  let html = '';

  const el = {
    get innerHTML() {
      return html;
    },
    set innerHTML(val: string) {
      html = val;
      childMap.clear();
      // Extract IDs from the HTML string and create fake elements
      const idMatches = [...val.matchAll(/id="([^"]+)"/g)];
      for (const match of idMatches) {
        const id = match[1];
        const tag = id.includes('audio') ? 'audio' : 'video';
        childMap.set(id, createFakeMediaElement(tag));
      }
    },
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  } as unknown as HTMLElement;

  return { el, childMap };
}

// =============================================
// buildAudioPlayerHTML
// =============================================
describe('buildAudioPlayerHTML', () => {
  it('returns HTML containing the thumbnail and title', () => {
    const html = buildAudioPlayerHTML('https://img.example.com/thumb.jpg', 'My Track');
    expect(html).toContain('https://img.example.com/thumb.jpg');
    expect(html).toContain('My Track');
  });

  it('contains the audio element with id="direct-audio"', () => {
    const html = buildAudioPlayerHTML('/thumb.webp', 'Title');
    expect(html).toContain('id="direct-audio"');
    expect(html).toContain('autoplay');
  });

  it('escapes HTML special characters in title', () => {
    const html = buildAudioPlayerHTML('/thumb.webp', '<script>alert("xss")</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML special characters in thumbnail URL', () => {
    const html = buildAudioPlayerHTML('/img?a=1&b=2"onload="alert(1)', 'Track');
    expect(html).not.toContain('&b=');
    expect(html).toContain('&amp;b=');
    expect(html).not.toContain('"onload=');
  });

  it('includes the audio container wrapper', () => {
    const html = buildAudioPlayerHTML('/t.jpg', 'T');
    expect(html).toContain('id="audio-container"');
  });

  it('includes reduced-motion media query', () => {
    const html = buildAudioPlayerHTML('/t.jpg', 'T');
    expect(html).toContain('prefers-reduced-motion');
  });
});

// =============================================
// isAudioUrl regex (extracted from setupDirectMedia)
// =============================================
describe('audio URL detection regex', () => {
  // The regex used inside setupDirectMedia:
  // /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i
  const isAudioUrl = (url: string) => /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i.test(url);

  it.each([
    'https://cdn.example.com/track.mp3',
    'https://cdn.example.com/track.MP3',
    '/audio/song.wav',
    '/audio/song.flac',
    '/audio/song.aac',
    '/audio/song.m4a',
    'https://cdn.example.com/track.mp3?token=abc123',
    'https://cdn.example.com/track.WAV?v=2',
  ])('identifies %s as audio', (url) => {
    expect(isAudioUrl(url)).toBe(true);
  });

  it.each([
    'https://cdn.example.com/video.mp4',
    'https://cdn.example.com/video.webm',
    'https://cdn.example.com/stream.m3u8',
    'https://example.com/mp3-info', // no dot before extension
    'https://example.com/song.mp3.bak', // extension followed by another
  ])('rejects %s as non-audio', (url) => {
    expect(isAudioUrl(url)).toBe(false);
  });
});

// =============================================
// isHlsUrl detection (from setupDirectMedia)
// =============================================
describe('HLS URL detection', () => {
  const isHlsUrl = (url: string) => url.includes('.m3u8');

  it.each([
    'https://stream.example.com/live.m3u8',
    'https://stream.example.com/live.m3u8?token=x',
    '/live/index.m3u8',
  ])('identifies %s as HLS', (url) => {
    expect(isHlsUrl(url)).toBe(true);
  });

  it.each([
    'https://cdn.example.com/track.mp3',
    'https://cdn.example.com/video.mp4',
    'https://cdn.example.com/m3u8-info',
  ])('rejects %s as non-HLS', (url) => {
    expect(isHlsUrl(url)).toBe(false);
  });
});

// =============================================
// setupDirectMedia
// =============================================
describe('setupDirectMedia', () => {
  let container: HTMLElement;
  let childMap: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    const fake = createFakeContainer();
    container = fake.el;
    childMap = fake.childMap;

    // Patch global document.getElementById to resolve from our childMap
    (globalThis.document as Record<string, unknown>).getElementById = vi.fn((id: string) => {
      return childMap.get(id) || null;
    });

    // Reset Hls mock
    hlsMock.loadSource.mockClear();
    hlsMock.attachMedia.mockClear();
    hlsMock.on.mockClear();
    (globalThis as Record<string, unknown>).Hls = Object.assign(
      vi.fn(function () { return hlsMock; }),
      {
        isSupported: vi.fn(() => true),
        Events: { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' },
      },
    );
  });

  it('returns a media element for an audio URL', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const item = makeItem({ url: 'https://cdn.example.com/track.mp3' });

    const result = setupDirectMedia(container, item, onReady, onError);

    expect(result.mediaElement).not.toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('sets audio src for audio URLs', () => {
    const item = makeItem({ url: 'https://cdn.example.com/song.flac' });
    const result = setupDirectMedia(container, item, vi.fn(), vi.fn());

    expect(result.mediaElement).not.toBeNull();
    expect(result.mediaElement!.src).toBe('https://cdn.example.com/song.flac');
  });

  it('calls buildAudioPlayerHTML for audio files (container gets audio HTML)', () => {
    const item = makeItem({
      url: 'https://cdn.example.com/song.mp3',
      title: 'My Song',
      thumbnail: '/art.jpg',
    });
    setupDirectMedia(container, item, vi.fn(), vi.fn());

    expect(container.innerHTML).toContain('id="audio-container"');
    expect(container.innerHTML).toContain('My Song');
  });

  it('uses placeholder thumbnail when item has no thumbnail', () => {
    const item = makeItem({ url: 'https://cdn.example.com/song.m4a', thumbnail: undefined });
    setupDirectMedia(container, item, vi.fn(), vi.fn());

    expect(container.innerHTML).toContain('/place-holder.webp');
  });

  it('uses default title when item has no title', () => {
    const item = makeItem({ url: 'https://cdn.example.com/song.aac', title: undefined });
    setupDirectMedia(container, item, vi.fn(), vi.fn());

    expect(container.innerHTML).toContain('Audio Track');
  });

  it('creates a video element for regular video URLs', () => {
    const onReady = vi.fn();
    const item = makeItem({ url: 'https://cdn.example.com/video.mp4' });

    const result = setupDirectMedia(container, item, onReady, vi.fn());

    expect(result.mediaElement).not.toBeNull();
    expect(container.innerHTML).toContain('id="direct-video"');
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('creates an HLS player when URL contains .m3u8 and Hls is supported', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const item = makeItem({ url: 'https://stream.example.com/live.m3u8' });

    const result = setupDirectMedia(container, item, onReady, onError);

    expect(result.mediaElement).not.toBeNull();
    expect(container.innerHTML).toContain('id="direct-video"');
    expect(hlsMock.loadSource).toHaveBeenCalledWith('https://stream.example.com/live.m3u8');
    expect(hlsMock.attachMedia).toHaveBeenCalled();
    expect(hlsMock.on).toHaveBeenCalledWith('hlsManifestParsed', expect.any(Function));
    expect(hlsMock.on).toHaveBeenCalledWith('hlsError', expect.any(Function));
  });

  it('calls onError for HLS fatal errors', () => {
    const onError = vi.fn();
    const item = makeItem({ url: 'https://stream.example.com/live.m3u8' });

    setupDirectMedia(container, item, vi.fn(), onError);

    // Find the ERROR callback registered on hls.on
    const errorCall = hlsMock.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'hlsError',
    );
    expect(errorCall).toBeDefined();

    // Invoke with fatal data
    const errorCallback = errorCall![1] as (event: unknown, data: { fatal?: boolean }) => void;
    errorCallback(undefined, { fatal: true });

    expect(onError).toHaveBeenCalledWith('HLS playback error');
  });

  it('does not call onError for non-fatal HLS errors', () => {
    const onError = vi.fn();
    const item = makeItem({ url: 'https://stream.example.com/live.m3u8' });

    setupDirectMedia(container, item, vi.fn(), onError);

    const errorCall = hlsMock.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'hlsError',
    );
    const errorCallback = errorCall![1] as (event: unknown, data: { fatal?: boolean }) => void;
    errorCallback(undefined, { fatal: false });

    expect(onError).not.toHaveBeenCalled();
  });

  it('falls back to native HLS when Hls.isSupported is false but canPlayType succeeds', () => {
    (globalThis as Record<string, unknown>).Hls = Object.assign(vi.fn(), {
      isSupported: vi.fn(() => false),
      Events: { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' },
    });

    // Create a video element that supports native HLS
    const fakeVideo = createFakeMediaElement('video');
    fakeVideo.canPlayType = vi.fn().mockReturnValue('maybe');
    (globalThis.document as Record<string, unknown>).getElementById = vi.fn(() => fakeVideo);

    const onReady = vi.fn();
    const item = makeItem({ url: 'https://stream.example.com/live.m3u8' });

    const result = setupDirectMedia(container, item, onReady, vi.fn());

    expect(result.mediaElement).not.toBeNull();
    expect(fakeVideo.src).toBe('https://stream.example.com/live.m3u8');
    expect(onReady).toHaveBeenCalled();
  });

  it('calls onError when HLS is not supported at all', () => {
    (globalThis as Record<string, unknown>).Hls = Object.assign(vi.fn(), {
      isSupported: vi.fn(() => false),
      Events: { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' },
    });

    // canPlayType returns empty string (no native HLS)
    const fakeVideo = createFakeMediaElement('video');
    (globalThis.document as Record<string, unknown>).getElementById = vi.fn(() => fakeVideo);

    const onError = vi.fn();
    const item = makeItem({ url: 'https://stream.example.com/live.m3u8' });

    const result = setupDirectMedia(container, item, vi.fn(), onError);

    expect(result.mediaElement).toBeNull();
    expect(result.error).toBe('HLS not supported');
    expect(onError).toHaveBeenCalledWith('HLS playback not supported');
  });

  it('calls play() on the created audio element', () => {
    const item = makeItem({ url: 'https://cdn.example.com/track.mp3' });
    const result = setupDirectMedia(container, item, vi.fn(), vi.fn());

    expect(result.mediaElement).not.toBeNull();
    expect(result.mediaElement!.play).toHaveBeenCalled();
  });

  it('calls play() on regular video elements', () => {
    const item = makeItem({ url: 'https://cdn.example.com/clip.mp4' });
    const result = setupDirectMedia(container, item, vi.fn(), vi.fn());

    expect(result.mediaElement).not.toBeNull();
    expect(result.mediaElement!.play).toHaveBeenCalled();
  });
});
