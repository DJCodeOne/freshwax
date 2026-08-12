import { describe, it, expect } from 'vitest';
import { assessReleaseReadiness } from '../lib/release/readiness';

const CDN = 'https://cdn.freshwax.co.uk/releases/x';

// A release that is genuinely finished.
const complete = () => ({
  tracks: [
    { title: 'A', mp3Url: `${CDN}/a.mp3`, previewUrl: `${CDN}/a.mp3`, wavUrl: `${CDN}/a.wav` },
    { title: 'B', mp3Url: `${CDN}/b.mp3`, previewUrl: `${CDN}/b.mp3`, wavUrl: `${CDN}/b.wav` },
  ],
  coverArtUrl: `${CDN}/cover.webp`,
  thumbUrl: `${CDN}/thumb.webp`,
  ogImageUrl: `${CDN}/og.webp`,
  artistId: 'uid-1',
  submitterId: 'uid-1',
  pricePerSale: 3,
  trackPrice: 1.5,
});

describe('assessReleaseReadiness', () => {
  it('passes a complete release', () => {
    const r = assessReleaseReadiness(complete());
    expect(r.ready).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  // The exact Drum Unit / WINK / Elipse state: audio never converted.
  it('blocks a WAV-only release', () => {
    const rel = complete();
    rel.tracks[0].mp3Url = `${CDN}/a.wav`;
    rel.tracks[0].previewUrl = `${CDN}/a.wav`;
    const r = assessReleaseReadiness(rel);
    expect(r.ready).toBe(false);
    expect(r.blocking.join()).toMatch(/not converted to MP3/i);
    expect(r.blocking.join()).toContain('A');
  });

  it('blocks when only the preview is still a raw master', () => {
    const rel = complete();
    rel.tracks[1].previewUrl = `${CDN}/b.wav`;
    expect(assessReleaseReadiness(rel).ready).toBe(false);
  });

  it('blocks aiff/flac masters too', () => {
    for (const ext of ['aiff', 'aif', 'flac']) {
      const rel = complete();
      rel.tracks[0].mp3Url = `${CDN}/a.${ext}`;
      rel.tracks[0].previewUrl = `${CDN}/a.${ext}`;
      expect(assessReleaseReadiness(rel).ready).toBe(false);
    }
  });

  it('blocks a track with no audio at all', () => {
    const rel = complete();
    rel.tracks[0] = { title: 'A' } as never;
    const r = assessReleaseReadiness(rel);
    expect(r.ready).toBe(false);
    expect(r.blocking.join()).toMatch(/No audio file/i);
  });

  it('blocks a release with no tracks', () => {
    const r = assessReleaseReadiness({ ...complete(), tracks: [] });
    expect(r.ready).toBe(false);
    expect(r.blocking.join()).toMatch(/no tracks/i);
  });

  it('blocks placeholder cover art', () => {
    const r = assessReleaseReadiness({ ...complete(), coverArtUrl: 'https://cdn.freshwax.co.uk/place-holder.webp' });
    expect(r.ready).toBe(false);
    expect(r.blocking.join()).toMatch(/Cover art/i);
  });

  it('blocks missing cover art', () => {
    const rel = complete();
    delete (rel as Partial<typeof rel>).coverArtUrl;
    expect(assessReleaseReadiness(rel).ready).toBe(false);
  });

  it('blocks an unowned release', () => {
    const r = assessReleaseReadiness({ ...complete(), artistId: '', submitterId: '' });
    expect(r.ready).toBe(false);
    expect(r.blocking.join()).toMatch(/no owner/i);
  });

  it('blocks a vinyl release with no vinyl price', () => {
    const r = assessReleaseReadiness({ ...complete(), vinylRelease: true, vinylPrice: 0 });
    expect(r.ready).toBe(false);
    expect(r.blocking.join()).toMatch(/vinyl price/i);
  });

  it('allows a vinyl release that is priced', () => {
    expect(assessReleaseReadiness({ ...complete(), vinylRelease: true, vinylPrice: 12 }).ready).toBe(true);
  });

  // Cosmetic gaps must NOT hold a release back.
  it('warns but does not block when the OG image is missing', () => {
    const r = assessReleaseReadiness({ ...complete(), ogImageUrl: '' });
    expect(r.ready).toBe(true);
    expect(r.warnings.join()).toMatch(/social share image/i);
  });

  it('warns but does not block when artwork was too large to thumbnail', () => {
    const rel = complete();
    rel.thumbUrl = rel.coverArtUrl;
    const r = assessReleaseReadiness(rel);
    expect(r.ready).toBe(true);
    expect(r.warnings.join()).toMatch(/thumbnail/i);
  });

  it('warns but does not block a free release', () => {
    const r = assessReleaseReadiness({ ...complete(), pricePerSale: 0, trackPrice: 0 });
    expect(r.ready).toBe(true);
    expect(r.warnings.join()).toMatch(/free/i);
  });

  it('reports every blocking problem at once, not just the first', () => {
    const r = assessReleaseReadiness({
      tracks: [{ title: 'A', mp3Url: `${CDN}/a.wav`, previewUrl: `${CDN}/a.wav` }],
      coverArtUrl: '',
      artistId: '',
      submitterId: '',
    });
    expect(r.blocking.length).toBeGreaterThanOrEqual(3);
  });

  it('tolerates a query string on the audio URL', () => {
    const rel = complete();
    rel.tracks[0].mp3Url = `${CDN}/a.mp3?v=2`;
    rel.tracks[0].previewUrl = `${CDN}/a.mp3?v=2`;
    expect(assessReleaseReadiness(rel).ready).toBe(true);
  });
});
