// The saved ("My Playlist") list used to be cached under one shared key, so a
// logged-out visitor on the same browser saw the previous user's tracks as
// saved, and they were merged into whoever logged in next.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/client-logger', () => ({ createClientLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

import { loadPersonalPlaylistFromStorage, savePersonalPlaylistToStorage, addToPersonalPlaylistItems } from '../lib/playlist-manager/personal-playlist';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('window', {});
});

const item = (id: string, url: string) => ({ id, url, platform: 'direct', title: id, addedAt: '' });
const LEGACY = 'freshwax_personal_playlist';

describe('personal playlist storage', () => {
  it('shows nothing from a previous account when logged out', () => {
    store.set(LEGACY, JSON.stringify([item('a', 'u1')]));
    savePersonalPlaylistToStorage([item('b', 'u2')], 'userA');
    expect(loadPersonalPlaylistFromStorage(null)).toEqual([]);
  });

  it('keeps each account separate', () => {
    savePersonalPlaylistToStorage([item('a', 'u1')], 'userA');
    expect(loadPersonalPlaylistFromStorage('userB')).toEqual([]);
    expect(loadPersonalPlaylistFromStorage('userA').map(i => i.id)).toEqual(['a']);
  });

  it('moves the old shared list and guest saves into the account on login, once', () => {
    store.set(LEGACY, JSON.stringify([item('old', 'u1')]));
    savePersonalPlaylistToStorage([item('guest', 'u2')], null);
    expect(loadPersonalPlaylistFromStorage('userA').map(i => i.id)).toEqual(['old', 'guest']);
    expect(store.has(LEGACY)).toBe(false);
    expect(loadPersonalPlaylistFromStorage(null)).toEqual([]);
    expect(loadPersonalPlaylistFromStorage('userB')).toEqual([]);
  });

  it('treats re-signed playlist-server links as the same saved track', () => {
    const saved = [item('a', 'https://playlist.freshwax.co.uk/music/x.mp3?expires=1&sig=a')];
    const r = addToPersonalPlaylistItems(saved, item('b', 'https://playlist.freshwax.co.uk/music/x.mp3?expires=2&sig=b'));
    expect(r.added).toBe(false);
  });
});
