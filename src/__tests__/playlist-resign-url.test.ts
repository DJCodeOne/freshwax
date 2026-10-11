// Links to the local playlist server expire a week after signing, so tracks
// from saved playlists stopped playing. The Worker re-signs them on the way
// back into the queue; the signature must match scripts/playlist-server.cjs.
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../lib/api-utils', () => ({
  fetchWithTimeout: vi.fn(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../lib/pusher', () => ({ simpleMd5: vi.fn() }));

import { refreshPlaylistServerUrl } from '../lib/playlist/helpers';
import { trackKey } from '../lib/playlist-manager/history';

const TOKEN = 'test-playlist-token';
const S = 'https://playlist.freshwax.co.uk';
// Same as the server's verifySignedUrl(): HMAC over "<encoded path>:<expires>"
const serverAccepts = (url: string) => {
  const u = new URL(url);
  const path = url.slice(S.length).split('?')[0];
  const expires = u.searchParams.get('expires')!;
  const expected = crypto.createHmac('sha256', TOKEN).update(`${path}:${expires}`).digest('hex');
  return expected === u.searchParams.get('sig') && Number(expires) > Date.now() / 1000;
};

describe('refreshPlaylistServerUrl', () => {
  const path = "/music/The%20Chameleon%20%E2%80%94%20Drum%20'n'%20Bass%20%5BeWfEbI8_3Hg%5D.mp3";
  const expired = `${S}${path}?expires=1760000000&sig=deadbeef`;

  it('re-signs an expired music link so the server accepts it for another week', async () => {
    const fresh = await refreshPlaylistServerUrl(expired, { PLAYLIST_ACCESS_TOKEN: TOKEN });
    expect(fresh.startsWith(`${S}${path}?expires=`)).toBe(true);
    expect(serverAccepts(fresh)).toBe(true);
    const expires = Number(new URL(fresh).searchParams.get('expires'));
    expect(expires - Date.now() / 1000).toBeGreaterThan(6.9 * 24 * 3600);
  });

  it('leaves other links alone', async () => {
    const yt = 'https://www.youtube.com/watch?v=abc123';
    expect(await refreshPlaylistServerUrl(yt, { PLAYLIST_ACCESS_TOKEN: TOKEN })).toBe(yt);
    const thumb = `${S}/thumb/x.webp?expires=1&sig=a`;
    expect(await refreshPlaylistServerUrl(thumb, { PLAYLIST_ACCESS_TOKEN: TOKEN })).toBe(thumb);
  });

  it('returns the link unchanged when no token is configured', async () => {
    expect(await refreshPlaylistServerUrl(expired, {})).toBe(expired);
  });
});

describe('trackKey', () => {
  it('treats differently-signed links to the same file as the same track', () => {
    expect(trackKey(`${S}/music/a.mp3?expires=1&sig=x`)).toBe(trackKey(`${S}/music/a.mp3?expires=2&sig=y`));
  });
  it('keeps the query for other hosts (YouTube ids live there)', () => {
    expect(trackKey('https://www.youtube.com/watch?v=a')).not.toBe(trackKey('https://www.youtube.com/watch?v=b'));
  });
});
