// src/lib/playlist/autoplay-unlock.ts
// Browsers refuse to start audio until the visitor interacts with the page,
// so after a refresh of /live the playlist track loads silently and the
// "Initialising…" overlay just sits there. When that happens, show a
// "Tap to listen" prompt and start the track (re-synced to the shared
// position) on the visitor's first click / key press anywhere on the page.

import type { PlaylistContext } from './types';
import type { EmbedPlayerManager } from '../embed-player';
import { hidePlaylistLoadingOverlay } from '../playlist-manager/ui';

const PROMPT_ID = 'playlistTapToPlay';
const CHECK_DELAY_MS = 3500;
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

let checkTimer: number | null = null;
let gestureHandler: ((e: Event) => void) | null = null;

function removePrompt(): void {
  document.getElementById(PROMPT_ID)?.remove();
}

function detachGesture(): void {
  if (gestureHandler) {
    for (const ev of GESTURE_EVENTS) document.removeEventListener(ev, gestureHandler, true);
    gestureHandler = null;
  }
}

/** Cancel any pending check / prompt (track change, live stream took over, destroy). */
export function cancelAutoplayUnlock(): void {
  if (checkTimer !== null) { clearTimeout(checkTimer); checkTimer = null; }
  detachGesture();
  removePrompt();
}

function showPrompt(): void {
  removePrompt();
  const host = document.getElementById('playlistPlayer')?.parentElement;
  if (!host) return;
  const el = document.createElement('button');
  el.id = PROMPT_ID;
  el.type = 'button';
  el.setAttribute('aria-label', 'Tap to listen to the playlist');
  el.style.cssText = 'position:absolute; inset:0; z-index:30; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.6rem; width:100%; height:100%; background:rgba(0,0,0,0.55); border:0; color:#fff; cursor:pointer; font-weight:800; letter-spacing:.05em; text-transform:uppercase;';
  el.innerHTML =
    '<span style="display:flex; align-items:center; justify-content:center; width:72px; height:72px; border-radius:50%; background:#dc2626; border:3px solid #fff; box-shadow:0 0 24px rgba(220,38,38,.6);">' +
    '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>' +
    '<span style="font-size:1rem; text-shadow:0 2px 8px rgba(0,0,0,.8);">Tap to listen</span>';
  host.appendChild(el);
}

/**
 * Start playback inside a user gesture: play() must be called synchronously
 * in the handler, then jump to where everyone else is in the track.
 */
function unlock(ctx: PlaylistContext, player: EmbedPlayerManager, calculateSyncPosition: (ctx: PlaylistContext) => number): void {
  cancelAutoplayUnlock();
  if (window.isLiveStreamActive || ctx.isPausedLocally) return;
  player.clearPendingSeek();
  void player.play();
  const pos = calculateSyncPosition(ctx);
  if (pos > 2) void player.seekTo(pos);
}

/**
 * Call after a playlist track has been loaded. If it still hasn't started a
 * few seconds later because autoplay was blocked, prompt for a tap.
 */
export function armAutoplayUnlock(
  ctx: PlaylistContext,
  player: EmbedPlayerManager,
  calculateSyncPosition: (ctx: PlaylistContext) => number,
): void {
  cancelAutoplayUnlock();
  checkTimer = window.setTimeout(() => {
    checkTimer = null;
    if (window.isLiveStreamActive || ctx.isPausedLocally) return;
    if (!player.isAutoplayBlocked()) return;

    hidePlaylistLoadingOverlay();
    showPrompt();
    gestureHandler = () => unlock(ctx, player, calculateSyncPosition);
    for (const ev of GESTURE_EVENTS) document.addEventListener(ev, gestureHandler, true);
  }, CHECK_DELAY_MS);
}
