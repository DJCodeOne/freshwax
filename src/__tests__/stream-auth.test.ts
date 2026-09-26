import { describe, it, expect } from 'vitest';
import { classifyStreamAuth, isAuthorizedStreamServer, isLoopbackIp, pickActiveSlot } from '../lib/stream-auth';

const KEY = 'fwx_8WmxYeCp_mokmn3oq_tea14a_099e86f9';

describe('isLoopbackIp', () => {
  it('recognises IPv4, IPv6 and mapped loopback', () => {
    for (const ip of ['127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1', '127.0.1.1']) expect(isLoopbackIp(ip)).toBe(true);
    for (const ip of ['90.207.8.79', '192.168.0.129', '', null, undefined, '::ffff:10.0.0.1']) expect(isLoopbackIp(ip)).toBe(false);
  });
});

describe('classifyStreamAuth', () => {
  it('always allows listeners', () => {
    expect(classifyStreamAuth({ action: 'read', path: `live/${KEY}`, ip: '8.8.8.8', protocol: 'hls' }).kind).toBe('allow');
    expect(classifyStreamAuth({ action: 'playback', path: 'x', ip: '8.8.8.8' }).kind).toBe('allow');
  });

  it('keeps the control API local', () => {
    expect(classifyStreamAuth({ action: 'api', ip: '127.0.0.1' }).kind).toBe('allow');
    expect(classifyStreamAuth({ action: 'api', ip: '90.207.8.79' }).kind).toBe('deny');
    expect(classifyStreamAuth({ action: 'metrics', ip: '192.168.0.10' }).kind).toBe('deny');
  });

  it("lets the streaming PC's ffmpeg feed the internal paths over RTMP", () => {
    expect(classifyStreamAuth({ action: 'publish', path: 'live/freshwax-main', protocol: 'rtmp', ip: '::1' }).kind).toBe('allow');
    expect(classifyStreamAuth({ action: 'publish', path: 'icecast-live', protocol: 'rtmp', ip: '127.0.0.1' }).kind).toBe('allow');
  });

  it('refuses the internal paths to everyone else, including WHIP through the tunnel', () => {
    // OBS from the internet trying to take over the Twitch/YouTube source
    expect(classifyStreamAuth({ action: 'publish', path: 'live/freshwax-main', protocol: 'rtmp', ip: '85.217.149.28' }).kind).toBe('deny');
    // Browser WHIP arrives via cloudflared, so it looks like loopback — still refused
    expect(classifyStreamAuth({ action: 'publish', path: 'live/freshwax-main', protocol: 'webrtc', ip: '::1' }).kind).toBe('deny');
    expect(classifyStreamAuth({ action: 'publish', path: 'icecast-live', protocol: 'webrtc', ip: '127.0.0.1' }).kind).toBe('deny');
  });

  it('sends DJ keys under live/ to the slot check, from any source', () => {
    for (const r of [
      { protocol: 'rtmp', ip: '82.132.233.23' },   // OBS / phone RTMP app
      { protocol: 'webrtc', ip: '::1' },          // browser WHIP via the tunnel
    ]) {
      expect(classifyStreamAuth({ action: 'publish', path: `live/${KEY}`, ...r })).toEqual({ kind: 'check-key', streamKey: KEY });
    }
  });

  it('refuses publishes that are not Fresh Wax stream keys', () => {
    for (const path of ['live/test', 'live/fwx_', 'live/fwx_only', KEY, `other/${KEY}`, 'live/fwx_a_b/../x', '']) {
      expect(classifyStreamAuth({ action: 'publish', path, protocol: 'rtmp', ip: '1.2.3.4' }).kind).toBe('deny');
    }
  });

  it('refuses unknown actions', () => {
    expect(classifyStreamAuth({ action: 'delete', path: `live/${KEY}` }).kind).toBe('deny');
    expect(classifyStreamAuth({}).kind).toBe('deny');
  });
});

describe('isAuthorizedStreamServer', () => {
  const secret = 's3cret-key';
  const basic = (user: string, pass: string) => new Headers({ authorization: `Basic ${btoa(`${user}:${pass}`)}` });

  it('accepts Basic auth from the authHTTPAddress userinfo (user name ignored)', () => {
    expect(isAuthorizedStreamServer(basic('mediamtx', secret), secret)).toBe(true);
    expect(isAuthorizedStreamServer(basic('anything', secret), secret)).toBe(true);
  });

  it('accepts the x-server-key header', () => {
    expect(isAuthorizedStreamServer(new Headers({ 'x-server-key': secret }), secret)).toBe(true);
  });

  it('rejects wrong, missing or malformed credentials', () => {
    expect(isAuthorizedStreamServer(basic('mediamtx', 'nope'), secret)).toBe(false);
    expect(isAuthorizedStreamServer(basic('mediamtx', ''), secret)).toBe(false);
    expect(isAuthorizedStreamServer(new Headers({ authorization: 'Basic !!!' }), secret)).toBe(false);
    expect(isAuthorizedStreamServer(new Headers({ authorization: `Bearer ${secret}` }), secret)).toBe(false);
    expect(isAuthorizedStreamServer(new Headers(), secret)).toBe(false);
  });

  it('rejects everything when the server key is not configured', () => {
    expect(isAuthorizedStreamServer(basic('mediamtx', ''), '')).toBe(false);
    expect(isAuthorizedStreamServer(new Headers({ 'x-server-key': 'x' }), undefined)).toBe(false);
  });
});

describe('pickActiveSlot', () => {
  const now = Date.parse('2026-09-26T20:10:00Z');
  const win = { earlyMs: 30 * 60_000, graceMs: 5 * 60_000 };
  const slot = (o: Record<string, unknown>) => ({
    id: 'x', status: 'scheduled', startTime: '2026-09-26T20:00:00Z', endTime: '2026-09-26T21:00:00Z',
    createdAt: '2026-09-20T10:00:00Z', streamKey: 'fwx_other_a_b_c', ...o,
  });

  it('finds a slot whose window includes now', () => {
    expect(pickActiveSlot([slot({ id: 'a' })], KEY, now, win)?.id).toBe('a');
  });

  it('allows connecting up to 30 minutes early and 5 minutes late', () => {
    const early = slot({ id: 'e', startTime: '2026-09-26T20:35:00Z', endTime: '2026-09-26T21:35:00Z' });
    const late = slot({ id: 'l', startTime: '2026-09-26T19:00:00Z', endTime: '2026-09-26T20:06:00Z' });
    const tooEarly = slot({ id: 't', startTime: '2026-09-26T20:45:00Z', endTime: '2026-09-26T21:45:00Z' });
    expect(pickActiveSlot([early], KEY, now, win)?.id).toBe('e');
    expect(pickActiveSlot([late], KEY, now, win)?.id).toBe('l');
    expect(pickActiveSlot([tooEarly], KEY, now, win)).toBeNull();
  });

  it('ignores cancelled, completed and malformed slots', () => {
    expect(pickActiveSlot([
      slot({ cancelled: true }),
      slot({ status: 'completed' }),
      slot({ status: 'cancelled' }),
      slot({ startTime: 'garbage' }),
    ], KEY, now, win)).toBeNull();
  });

  it('prefers the slot already on this key, then a live slot, then the newest', () => {
    const booked = slot({ id: 'booked', createdAt: '2026-09-26T20:05:00Z' });
    const live = slot({ id: 'live', status: 'live', createdAt: '2026-09-26T20:01:00Z' });
    const onKey = slot({ id: 'onKey', createdAt: '2026-09-01T00:00:00Z', streamKey: KEY });
    expect(pickActiveSlot([booked, live, onKey], KEY, now, win)?.id).toBe('onKey');
    expect(pickActiveSlot([booked, live], KEY, now, win)?.id).toBe('live');
    expect(pickActiveSlot([slot({ id: 'old' }), booked], KEY, now, win)?.id).toBe('booked');
  });

  it('still accepts the legacy "connecting" status', () => {
    expect(pickActiveSlot([slot({ id: 'c', status: 'connecting' })], KEY, now, win)?.id).toBe('c');
  });
});
