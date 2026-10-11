// After a refresh of /live the browser blocks the playlist's autoplay. The
// page must prompt for a tap and start the track on the first interaction,
// re-synced to the shared position — not sit on "Initialising…" in silence.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/playlist-manager/ui', () => ({ hidePlaylistLoadingOverlay: vi.fn() }));

type Listener = (e: Event) => void;
let listeners: Map<string, Set<Listener>>;
let elements: Map<string, { id: string; remove: () => void }>;

function fireDocument(type: string) {
  for (const fn of [...(listeners.get(type) || [])]) fn(new Event(type));
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Map();
  elements = new Map();
  const host = {
    appendChild: (el: { id: string }) => { elements.set(el.id, el as { id: string; remove: () => void }); },
  };
  const doc = {
    getElementById: (id: string) => (id === 'playlistPlayer' ? { parentElement: host } : elements.get(id) ?? null),
    createElement: () => {
      const el = { id: '', type: '', style: { cssText: '' }, innerHTML: '', setAttribute: () => {}, remove: () => { elements.delete(el.id); } };
      return el;
    },
    addEventListener: (t: string, fn: Listener) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); },
    removeEventListener: (t: string, fn: Listener) => { listeners.get(t)?.delete(fn); },
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { setTimeout, clearTimeout, isLiveStreamActive: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function makePlayer(blocked: boolean) {
  return {
    isAutoplayBlocked: vi.fn(() => blocked),
    clearPendingSeek: vi.fn(),
    play: vi.fn(async () => {}),
    seekTo: vi.fn(async () => {}),
  };
}

const ctx = () => ({ isPausedLocally: false }) as never;

describe('playlist autoplay unlock', () => {
  it('prompts when autoplay was blocked, then plays at the synced position on first tap', async () => {
    const { armAutoplayUnlock } = await import('../lib/playlist/autoplay-unlock');
    const player = makePlayer(true);
    armAutoplayUnlock(ctx(), player as never, () => 95);
    vi.advanceTimersByTime(4000);
    expect(elements.has('playlistTapToPlay')).toBe(true);

    fireDocument('pointerdown');
    expect(player.clearPendingSeek).toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekTo).toHaveBeenCalledWith(95);
    expect(elements.has('playlistTapToPlay')).toBe(false);

    fireDocument('pointerdown'); // listeners removed after the first gesture
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the track is already playing', async () => {
    const { armAutoplayUnlock } = await import('../lib/playlist/autoplay-unlock');
    const player = makePlayer(false);
    armAutoplayUnlock(ctx(), player as never, () => 95);
    vi.advanceTimersByTime(4000);
    expect(elements.has('playlistTapToPlay')).toBe(false);
    fireDocument('pointerdown');
    expect(player.play).not.toHaveBeenCalled();
  });

  it('stays out of the way once a live stream takes over', async () => {
    const { armAutoplayUnlock } = await import('../lib/playlist/autoplay-unlock');
    const player = makePlayer(true);
    (window as { isLiveStreamActive?: boolean }).isLiveStreamActive = true;
    armAutoplayUnlock(ctx(), player as never, () => 95);
    vi.advanceTimersByTime(4000);
    expect(elements.has('playlistTapToPlay')).toBe(false);
  });

  it('cancel removes the prompt and the tap listener', async () => {
    const { armAutoplayUnlock, cancelAutoplayUnlock } = await import('../lib/playlist/autoplay-unlock');
    const player = makePlayer(true);
    armAutoplayUnlock(ctx(), player as never, () => 95);
    vi.advanceTimersByTime(4000);
    cancelAutoplayUnlock();
    expect(elements.has('playlistTapToPlay')).toBe(false);
    fireDocument('keydown');
    expect(player.play).not.toHaveBeenCalled();
  });
});
