// src/lib/stream-auth.ts
// Rules for MediaMTX's HTTP auth hook (src/pages/api/livestream/validate-stream.ts).
// Pure functions so the rules are unit-tested; the endpoint does the I/O.

import { timingSafeCompare } from './api-utils';

/**
 * Paths only the streaming PC's own ffmpeg processes publish to (all over RTMP
 * to localhost — see C:\mediamtx\multistream-relay.ps1 and icecast-bridge.bat).
 */
export const INTERNAL_PUBLISH_PATHS: ReadonlySet<string> = new Set([
  'live/freshwax-main', // multistream producer: the source for the Twitch/YouTube fan-out
  'icecast-live',       // Icecast -> MediaMTX bridge (BUTT audio for the website)
  'live/butt-stream',   // legacy BUTT path
]);

// Protocols a local ffmpeg can publish with. WebRTC is left out on purpose:
// WHIP arrives through the Cloudflare tunnel, which MediaMTX also sees as
// loopback, so "loopback + webrtc" is really a visitor from the internet.
const LOCAL_PUBLISH_PROTOCOLS: ReadonlySet<string> = new Set(['rtmp', 'rtmps', 'rtsp', 'rtsps', 'srt']);

// Slot statuses a DJ can legitimately be streaming into. 'connecting' is a
// legacy value this hook used to write; accepted so an old slot never blocks.
const PUBLISHABLE_SLOT_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'in_lobby', 'queued', 'live', 'connecting']);

// Shape of a DJ stream key: fwx_<djIdShort>_<slotIdShort>_<time>_<signature>
// (red5.ts generateStreamKey). Kept loose — the real check is the slot history.
const STREAM_KEY_RE = /^fwx_[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)+$/;

export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return v === '::1' || v.startsWith('127.') || v.startsWith('::ffff:127.');
}

/** The fields of MediaMTX's auth request this module looks at. */
export interface StreamAuthRequest {
  action?: string | null;
  path?: string | null;
  protocol?: string | null;
  ip?: string | null;
}

export type StreamAuthDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'check-key'; streamKey: string };

/**
 * Decide everything that doesn't need a database lookup. A DJ publish comes
 * back as `check-key`: the caller must still confirm the key belongs to a DJ
 * with an active slot (see pickActiveSlot).
 */
export function classifyStreamAuth(req: StreamAuthRequest): StreamAuthDecision {
  const action = (req.action || '').toLowerCase();
  const path = (req.path || '').replace(/^\/+/, '');
  const protocol = (req.protocol || '').toLowerCase();
  const loopback = isLoopbackIp(req.ip);

  if (action === 'read' || action === 'playback') {
    return { kind: 'allow', reason: 'public playback' };
  }
  if (action === 'api' || action === 'metrics' || action === 'pprof') {
    // MediaMTX's own default: the control API is for the streaming PC only.
    return loopback
      ? { kind: 'allow', reason: 'local control API' }
      : { kind: 'deny', reason: 'control API is local only' };
  }
  if (action !== 'publish') {
    return { kind: 'deny', reason: `unknown action "${action}"` };
  }

  if (INTERNAL_PUBLISH_PATHS.has(path)) {
    return loopback && LOCAL_PUBLISH_PROTOCOLS.has(protocol)
      ? { kind: 'allow', reason: 'internal publisher' }
      : { kind: 'deny', reason: `"${path}" is fed by the streaming PC only` };
  }

  // DJs publish to live/<key>: OBS/phone apps use rtmp://rtmp.freshwax.co.uk/live
  // + key, browsers use /live/<key>/whip. Anything else is not a Fresh Wax stream.
  if (!path.startsWith('live/')) {
    return { kind: 'deny', reason: 'streams must publish under live/' };
  }
  const streamKey = path.slice('live/'.length);
  if (!STREAM_KEY_RE.test(streamKey)) {
    return { kind: 'deny', reason: 'not a Fresh Wax stream key' };
  }
  return { kind: 'check-key', streamKey };
}

/**
 * True when the request comes from our MediaMTX (or a manual test with the
 * same secret). MediaMTX can't set custom headers, so it authenticates with
 * HTTP Basic auth taken from the URL userinfo in authHTTPAddress
 * (https://mediamtx:<STREAM_SERVER_KEY>@freshwax.co.uk/…); the user name is
 * ignored. The x-server-key header the relay scripts use works too.
 */
export function isAuthorizedStreamServer(headers: Headers, expectedKey: string | null | undefined): boolean {
  if (!expectedKey) return false;

  const direct = headers.get('x-server-key');
  if (direct && timingSafeCompare(direct, expectedKey)) return true;

  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(headers.get('authorization') || '');
  if (!match) return false;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const password = decoded.slice(sep + 1);
  return password.length > 0 && timingSafeCompare(password, expectedKey);
}

export interface PublishableSlot {
  id?: unknown;
  status?: unknown;
  cancelled?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  createdAt?: unknown;
  streamKey?: unknown;
}

/**
 * The slot a publish with `streamKey` belongs to, among one DJ's slots: an
 * uncancelled slot in a publishable status whose window (start - earlyMs ..
 * end + graceMs) includes now. Preference: the slot already on this key, then
 * a live slot, then the most recently created — so a booking made while the
 * DJ is live never steals the live slot's key.
 */
export function pickActiveSlot<T extends PublishableSlot>(
  slots: T[],
  streamKey: string,
  nowMs: number,
  window: { earlyMs: number; graceMs: number },
): T | null {
  const time = (v: unknown) => {
    const t = Date.parse(String(v ?? ''));
    return Number.isFinite(t) ? t : NaN;
  };
  const candidates = slots.filter((s) => {
    if (!PUBLISHABLE_SLOT_STATUSES.has(String(s.status))) return false;
    if (s.cancelled) return false;
    const start = time(s.startTime);
    const end = time(s.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return nowMs >= start - window.earlyMs && nowMs <= end + window.graceMs;
  });
  const rank = (s: T) => (s.streamKey === streamKey ? 2 : 0) + (s.status === 'live' ? 1 : 0);
  candidates.sort((a, b) => rank(b) - rank(a) || (time(b.createdAt) || 0) - (time(a.createdAt) || 0));
  return candidates[0] ?? null;
}
