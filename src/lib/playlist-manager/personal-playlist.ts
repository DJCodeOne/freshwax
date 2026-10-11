// src/lib/playlist-manager/personal-playlist.ts
// Personal playlist (user's saved tracks) — localStorage + D1 cloud sync for Plus users

import { createClientLogger } from '../client-logger';
import { PERSONAL_PLAYLIST_KEY } from './types';
import type { PersonalPlaylistItem } from './types';
import { trackKey } from './history';

const log = createClientLogger('PersonalPlaylist');

// The cached playlist is kept per account (plus one for logged-out visitors).
// It used to live under a single shared key, so after logging out — or on a
// shared PC — the next visitor saw the previous user's saved tracks (the
// now-playing button showed "Already in My Playlist") and, on login, those
// tracks were merged into whoever signed in next.
const GUEST = 'guest';
const storageKey = (userId?: string | null) => `${PERSONAL_PLAYLIST_KEY}:${userId || GUEST}`;
const sameTrack = (a: string, b: string) => trackKey(a) === trackKey(b);

function readItems(key: string): PersonalPlaylistItem[] {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (error: unknown) {
    log.error('Error loading personal playlist:', error);
  }
  return [];
}

/**
 * Load the personal playlist cached for this user (or the guest list when
 * logged out). On a signed-in load, the legacy shared list and any tracks
 * saved while logged out are folded into the account and cleared.
 */
export function loadPersonalPlaylistFromStorage(userId?: string | null): PersonalPlaylistItem[] {
  const items = readItems(storageKey(userId));
  if (!userId) return items;

  let merged = items;
  for (const key of [PERSONAL_PLAYLIST_KEY, storageKey(null)]) {
    const extra = readItems(key);
    if (extra.length === 0) continue;
    for (const item of extra) {
      if (item?.url && !merged.some(m => sameTrack(m.url, item.url))) merged = [...merged, item];
    }
    try { localStorage.removeItem(key); } catch { /* storage disabled */ }
  }
  if (merged !== items) savePersonalPlaylistToStorage(merged, userId);
  return merged;
}

/**
 * Save personal playlist to localStorage for this user (guest when logged out)
 */
export function savePersonalPlaylistToStorage(items: PersonalPlaylistItem[], userId?: string | null): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(items));
  } catch (error: unknown) {
    log.error('Error saving personal playlist to localStorage:', error);
  }
}

/**
 * Save personal playlist to D1 (async, non-blocking).
 * Only saves for Plus users - Standard users use local storage only.
 */
export async function savePersonalPlaylistToServer(
  items: PersonalPlaylistItem[],
  userId: string
): Promise<void> {
  if (!userId) return;

  // Skip if user doesn't have cloud sync (not Plus)
  if (window.userHasCloudSync === false) {
    return;
  }

  try {
    // Get Firebase auth token for authorization
    const currentUser = window.firebaseAuth?.currentUser;
    const idToken = currentUser ? await currentUser.getIdToken() : null;

    if (!idToken) {
      log.warn('No auth token, skipping cloud save');
      return;
    }

    const response = await fetch('/api/playlist/personal/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        userId: userId,
        items: items
      })
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (result.isPlus === false) {
      // User is not Plus - mark it and skip future saves
      window.userHasCloudSync = false;
      return;
    }

  } catch (error: unknown) {
    log.error('Error saving personal playlist to D1:', error);
  }
}

/**
 * Load personal playlist from D1 (called when user authenticates).
 * Cloud sync is Plus-only - Standard users only use localStorage.
 * Returns the merged playlist items.
 */
export async function loadPersonalPlaylistFromServer(
  userId: string,
  localItems: PersonalPlaylistItem[]
): Promise<{ items: PersonalPlaylistItem[]; changed: boolean }> {
  if (!userId) {
    return { items: localItems, changed: false };
  }

  try {
    // Get Firebase auth token for authorization
    const currentUser = window.firebaseAuth?.currentUser;
    const idToken = currentUser ? await currentUser.getIdToken() : null;

    const fetchHeaders: Record<string, string> = {};
    if (idToken) {
      fetchHeaders['Authorization'] = `Bearer ${idToken}`;
    }

    const response = await fetch(`/api/playlist/personal/?userId=${encodeURIComponent(userId)}`, {
      headers: fetchHeaders
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    // Check if user has Plus for cloud sync
    if (result.isPlus === false) {
      // Store Plus status for later use
      window.userHasCloudSync = false;
      return { items: localItems, changed: false };
    }

    window.userHasCloudSync = true;

    if (result.success && Array.isArray(result.playlist)) {
      // Merge with localStorage (D1 takes priority for duplicates)
      const d1Items = result.playlist as PersonalPlaylistItem[];

      // Create a map of existing URLs from D1
      const d1Urls = new Set(d1Items.map((item) => trackKey(item.url)));

      // Add local items that aren't in D1
      const mergedItems = [...d1Items];
      for (const localItem of localItems) {
        if (!d1Urls.has(trackKey(localItem.url))) {
          mergedItems.push(localItem);
        }
      }

      return { items: mergedItems, changed: true };
    }
  } catch (error: unknown) {
    log.error('Error loading personal playlist from D1:', error);
  }

  // Keep using localStorage data
  return { items: localItems, changed: false };
}

/**
 * Add a track to personal playlist items. Returns updated array and status.
 * Plus users: 1000 tracks with cloud sync
 * Standard users: 100 tracks local only
 */
export function addToPersonalPlaylistItems(
  items: PersonalPlaylistItem[],
  newItem: PersonalPlaylistItem
): { items: PersonalPlaylistItem[]; added: boolean; error?: string } {
  // Check if already in personal playlist
  const alreadyInPlaylist = items.some(item => sameTrack(item.url, newItem.url));
  if (alreadyInPlaylist) {
    return { items, added: false, error: 'This track is already in your playlist' };
  }

  // Determine max size based on subscription
  const hasCloudSync = window.userHasCloudSync === true;
  const maxSize = hasCloudSync ? 1000 : 100;

  // Check max size
  if (items.length >= maxSize) {
    if (hasCloudSync) {
      return { items, added: false, error: `Your cloud playlist is full (${maxSize} tracks max)` };
    } else {
      return { items, added: false, error: `Your playlist is full (${maxSize} tracks). Upgrade to Plus for 1,000 tracks with cloud sync!` };
    }
  }

  return { items: [...items, newItem], added: true };
}

/**
 * Remove a track from personal playlist items by ID. Returns updated array.
 */
export function removeFromPersonalPlaylistItems(
  items: PersonalPlaylistItem[],
  itemId: string
): PersonalPlaylistItem[] {
  const index = items.findIndex(item => item.id === itemId);
  if (index >= 0) {
    const newItems = [...items];
    newItems.splice(index, 1);
    return newItems;
  }
  return items;
}
