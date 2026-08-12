import { describe, it, expect } from 'vitest';
import { buildAudioQueue, mergeConvertedTracks, urlToKey, isRawMaster, isWebReady } from '../lib/release/audio-queue';

const CDN = 'https://cdn.freshwax.co.uk';
const FOLDER = 'releases/test_release_1';

const release = (over: Record<string, unknown> = {}) => ({
  id: 'rel-1', title: 'Test EP', artistName: 'Tester', status: 'pending',
  r2FolderPath: FOLDER,
  tracks: [
    { trackNumber: 1, title: 'A', mp3Url: `${CDN}/${FOLDER}/a.wav`, previewUrl: `${CDN}/${FOLDER}/a.wav`, wavUrl: `${CDN}/${FOLDER}/a.wav` },
    { trackNumber: 2, title: 'B', mp3Url: `${CDN}/${FOLDER}/b.mp3`, previewUrl: `${CDN}/${FOLDER}/b.mp3`, wavUrl: `${CDN}/${FOLDER}/b.wav` },
  ],
  ...over,
});

describe('url helpers', () => {
  it('detects raw masters and web-ready audio', () => {
    expect(isRawMaster(`${CDN}/x.wav`)).toBe(true);
    expect(isRawMaster(`${CDN}/x.aiff`)).toBe(true);
    expect(isRawMaster(`${CDN}/x.flac`)).toBe(true);
    expect(isRawMaster(`${CDN}/x.mp3`)).toBe(false);
    expect(isWebReady(`${CDN}/x.mp3?v=2`)).toBe(true);
  });

  it('converts a CDN url back to an R2 key, decoding escapes', () => {
    expect(urlToKey(`${CDN}/${FOLDER}/a.wav`, CDN)).toBe(`${FOLDER}/a.wav`);
    expect(urlToKey(`${CDN}/${FOLDER}/My%20Track.wav`, CDN)).toBe(`${FOLDER}/My Track.wav`);
  });
});

describe('buildAudioQueue', () => {
  it('queues only the track that is still a raw master', () => {
    const q = buildAudioQueue([release()], CDN);
    expect(q).toHaveLength(1);
    expect(q[0].tracks).toHaveLength(1);
    expect(q[0].tracks[0]).toMatchObject({ trackNumber: 1, title: 'A', sourceKey: `${FOLDER}/a.wav` });
  });

  it('queues a track whose mp3Url is fine but previewUrl is still raw', () => {
    // The Marc OFX / Deadly Silence case: downloads fine, preview streams a WAV.
    const r = release();
    r.tracks = [{ trackNumber: 1, title: 'A', mp3Url: `${CDN}/${FOLDER}/a.mp3`, previewUrl: `${CDN}/${FOLDER}/a.wav`, wavUrl: `${CDN}/${FOLDER}/a.wav` }];
    const q = buildAudioQueue([r], CDN);
    expect(q).toHaveLength(1);
    expect(q[0].tracks[0].sourceKey).toBe(`${FOLDER}/a.wav`);
  });

  it('returns nothing for a fully converted release', () => {
    const r = release();
    r.tracks = [{ trackNumber: 1, title: 'A', mp3Url: `${CDN}/${FOLDER}/a.mp3`, previewUrl: `${CDN}/${FOLDER}/a.mp3`, wavUrl: `${CDN}/${FOLDER}/a.wav` }];
    expect(buildAudioQueue([r], CDN)).toEqual([]);
  });

  it('ignores releases with no tracks', () => {
    expect(buildAudioQueue([release({ tracks: [] })], CDN)).toEqual([]);
  });

  it('skips a track with no raw source to convert from', () => {
    const r = release();
    r.tracks = [{ trackNumber: 1, title: 'A', mp3Url: '', previewUrl: '', wavUrl: '' }];
    expect(buildAudioQueue([r], CDN)).toEqual([]);
  });

  it('covers live releases too, not just pending ones', () => {
    const q = buildAudioQueue([release({ status: 'live' })], CDN);
    expect(q[0].status).toBe('live');
  });

  it('falls back to a conventional folder when r2FolderPath is missing', () => {
    const r = release();
    delete (r as Partial<typeof r>).r2FolderPath;
    expect(buildAudioQueue([r], CDN)[0].releaseFolder).toBe('releases/rel-1');
  });
});

describe('mergeConvertedTracks', () => {
  const existing = [
    { trackNumber: 1, title: 'A', bpm: 165, trackISRC: 'ABC', mp3Url: `${CDN}/a.wav`, previewUrl: `${CDN}/a.wav`, wavUrl: `${CDN}/a.wav` },
    { trackNumber: 2, title: 'B', bpm: 170, mp3Url: `${CDN}/b.mp3`, previewUrl: `${CDN}/b.mp3`, wavUrl: `${CDN}/b.wav` },
  ];

  it('updates the matching track and preserves its metadata', () => {
    const { tracks, updated } = mergeConvertedTracks(existing, [
      { trackNumber: 1, mp3Url: `${CDN}/a.mp3`, duration: '6:49' },
    ]);
    expect(updated).toBe(1);
    expect(tracks[0]).toMatchObject({ mp3Url: `${CDN}/a.mp3`, previewUrl: `${CDN}/a.mp3`, bpm: 165, trackISRC: 'ABC', duration: '6:49' });
    expect(tracks[1]).toEqual(existing[1]); // untouched
  });

  it('keeps the original master when the agent does not supply one', () => {
    const { tracks } = mergeConvertedTracks(existing, [{ trackNumber: 1, mp3Url: `${CDN}/a.mp3` }]);
    expect(tracks[0].wavUrl).toBe(`${CDN}/a.wav`);
  });

  it('refuses a result that is not an mp3, so a bad agent cannot downgrade a track', () => {
    const { tracks, updated } = mergeConvertedTracks(existing, [
      { trackNumber: 1, mp3Url: `${CDN}/a.wav` },
    ]);
    expect(updated).toBe(0);
    expect(tracks[0].mp3Url).toBe(`${CDN}/a.wav`); // unchanged
  });

  it('ignores results for track numbers that do not exist', () => {
    const { updated } = mergeConvertedTracks(existing, [{ trackNumber: 99, mp3Url: `${CDN}/z.mp3` }]);
    expect(updated).toBe(0);
  });

  it('falls back to mp3Url when the supplied previewUrl is raw', () => {
    const { tracks } = mergeConvertedTracks(existing, [
      { trackNumber: 1, mp3Url: `${CDN}/a.mp3`, previewUrl: `${CDN}/a.wav` },
    ]);
    expect(tracks[0].previewUrl).toBe(`${CDN}/a.mp3`);
  });
});
