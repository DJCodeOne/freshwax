// Integration test for the auto-publish decision as the upload endpoints
// actually compute it:  autoPublish = isEstablishedPartner && readiness.ready
// Driven by real production release documents.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { isEstablishedPartner, releaseStatusFields } from '../lib/release/auto-approve';
import { assessReleaseReadiness } from '../lib/release/readiness';

const DUMP = new URL('./fixtures/releases.sample.json', import.meta.url);
const all = JSON.parse(fs.readFileSync(DUMP, 'utf8')) as Record<string, unknown>[];
const byId = (id: string) => all.find(r => r.id === id)!;

const DRUM_UNIT_UID = 'HVXl6a4BQ7WmSw4QemNP76Qnktm2';
const DRUM_UNIT_RELEASE = 'drum_unit_recordings_FW-1786529398020';

// Mirrors the endpoints' query: fetch the owner's releases by either field.
const realFetcher = async (field: string, value: string) =>
  all.filter(r => r[field] === value);

/** Exactly what process-release.ts / complete-upload.ts now do. */
async function decide(release: Record<string, unknown>, ownerId: string, excludeId?: string) {
  const isEstablished = await isEstablishedPartner(ownerId, realFetcher, excludeId);
  const readiness = assessReleaseReadiness(release);
  const autoPublish = isEstablished && readiness.ready;
  return { isEstablished, readiness, autoPublish, fields: releaseStatusFields(autoPublish, 'NOW') };
}

describe('auto-publish decision, against real catalogue data', () => {
  it('Drum Unit is now an established partner (his release is live)', async () => {
    const r = await decide(byId(DRUM_UNIT_RELEASE), DRUM_UNIT_UID);
    expect(r.isEstablished).toBe(true);
  });

  it('his NEXT upload, if complete, publishes straight to live', async () => {
    const next = { ...byId(DRUM_UNIT_RELEASE), id: 'new-upload' };
    const r = await decide(next, DRUM_UNIT_UID, 'new-upload');
    expect(r.autoPublish).toBe(true);
    expect(r.fields).toMatchObject({ status: 'live', published: true, approved: true, autoApproved: true });
  });

  // The whole point of the gate.
  it('his next upload is HELD if the audio was never converted', async () => {
    const next = JSON.parse(JSON.stringify(byId(DRUM_UNIT_RELEASE)));
    next.id = 'new-upload';
    next.tracks.forEach((t: Record<string, unknown>) => {
      t.mp3Url = String(t.wavUrl);
      t.previewUrl = String(t.wavUrl);
    });
    const r = await decide(next, DRUM_UNIT_UID, 'new-upload');
    expect(r.isEstablished).toBe(true);      // he IS established...
    expect(r.readiness.ready).toBe(false);   // ...but the release is not ready
    expect(r.autoPublish).toBe(false);
    expect(r.fields).toMatchObject({ status: 'pending', published: false, approved: false });
    expect(r.readiness.blocking.join()).toMatch(/not converted to MP3/i);
  });

  it('his next upload is HELD if artwork fell back to the placeholder', async () => {
    const next = { ...byId(DRUM_UNIT_RELEASE), id: 'new-upload' } as Record<string, unknown>;
    next.coverArtUrl = 'https://cdn.freshwax.co.uk/place-holder.webp';
    next.coverUrl = next.coverArtUrl;
    next.artworkUrl = next.coverArtUrl;
    const r = await decide(next, DRUM_UNIT_UID, 'new-upload');
    expect(r.autoPublish).toBe(false);
    expect(r.readiness.blocking.join()).toMatch(/Cover art/i);
  });

  it('a brand-new partner is never auto-published, even with a perfect release', async () => {
    const next = { ...byId(DRUM_UNIT_RELEASE), id: 'new-upload', artistId: 'brand-new-uid', submitterId: 'brand-new-uid' };
    const r = await decide(next, 'brand-new-uid', 'new-upload');
    expect(r.isEstablished).toBe(false);
    expect(r.autoPublish).toBe(false);
    expect(r.fields.status).toBe('pending');
  });

  it('an unresolvable owner is never auto-published', async () => {
    const next = { ...byId(DRUM_UNIT_RELEASE), id: 'new-upload', artistId: '', submitterId: '' };
    const r = await decide(next, '', 'new-upload');
    expect(r.autoPublish).toBe(false);
    expect(r.readiness.blocking.join()).toMatch(/no owner/i);
  });

  it('every currently-live release would pass the owner + cover checks', () => {
    // Sanity: the gate must not be so strict it would have rejected the
    // existing catalogue for reasons unrelated to audio.
    const live = all.filter(r => r.status === 'live');
    for (const r of live) {
      const blocking = assessReleaseReadiness(r).blocking.join();
      expect(blocking, `${r.title}`).not.toMatch(/no owner|Cover art/i);
    }
  });

  it('the whole live catalogue is now audio-clean, so nothing would be held', () => {
    const held = all
      .filter(r => r.status === 'live')
      .filter(r => !assessReleaseReadiness(r).ready)
      .map(r => `${r.artistName} — ${r.title}`);
    expect(held).toEqual([]);
  });
});
