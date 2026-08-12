import { describe, it, expect } from 'vitest';
import {
  countLiveReleases,
  isEstablishedPartner,
  releaseStatusFields,
} from '../lib/release/auto-approve';

const OWNER = 'owner-uid-1';
const OTHER = 'owner-uid-2';

const live = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  status: 'live',
  submitterId: OWNER,
  ...fields,
});

describe('countLiveReleases', () => {
  it('counts a partner\'s live releases', () => {
    expect(countLiveReleases([live('a'), live('b')], OWNER)).toBe(2);
  });

  it('ignores pending and rejected releases', () => {
    const releases = [live('a'), live('b', { status: 'pending' }), live('c', { status: 'rejected' })];
    expect(countLiveReleases(releases, OWNER)).toBe(1);
  });

  it('ignores releases belonging to someone else', () => {
    expect(countLiveReleases([live('a', { submitterId: OTHER })], OWNER)).toBe(0);
  });

  it('matches on the legacy artistId field', () => {
    const legacy = { id: 'a', status: 'live', submitterId: '', artistId: OWNER };
    expect(countLiveReleases([legacy], OWNER)).toBe(1);
  });

  it('does not count the release currently being uploaded', () => {
    expect(countLiveReleases([live('a'), live('new')], OWNER, 'new')).toBe(1);
  });

  it('deduplicates a release returned by both ownership queries', () => {
    const both = { id: 'a', status: 'live', submitterId: OWNER, artistId: OWNER };
    expect(countLiveReleases([both, both], OWNER)).toBe(1);
  });

  it('returns 0 for an unresolved owner', () => {
    expect(countLiveReleases([live('a', { submitterId: '' })], '')).toBe(0);
  });
});

describe('isEstablishedPartner', () => {
  const fetcher = (rows: Array<Record<string, unknown>>) =>
    async (field: string, value: string) => rows.filter((r) => r[field] === value);

  it('is true once the partner has a live release', async () => {
    expect(await isEstablishedPartner(OWNER, fetcher([live('a')]))).toBe(true);
  });

  it('is false for a partner with no live releases', async () => {
    expect(await isEstablishedPartner(OWNER, fetcher([live('a', { status: 'pending' })]))).toBe(false);
  });

  it('is false for a first-time uploader', async () => {
    expect(await isEstablishedPartner(OWNER, fetcher([]))).toBe(false);
  });

  it('never auto-publishes when the owner could not be resolved', async () => {
    let called = false;
    await isEstablishedPartner('', async () => { called = true; return [live('a')]; });
    expect(called).toBe(false);
  });

  it('falls back to manual approval if the lookup fails', async () => {
    const boom = async () => { throw new Error('firestore down'); };
    expect(await isEstablishedPartner(OWNER, boom)).toBe(false);
  });

  it('excludes the in-flight release, so a first upload stays pending', async () => {
    // The release being created may already have been written by an earlier
    // step; it must not count as prior catalogue for its own decision.
    expect(await isEstablishedPartner(OWNER, fetcher([live('new')]), 'new')).toBe(false);
  });
});

describe('releaseStatusFields', () => {
  const now = '2026-08-12T00:00:00.000Z';

  it('publishes established partners immediately', () => {
    expect(releaseStatusFields(true, now)).toEqual({
      status: 'live', published: true, approved: true, approvedAt: now, autoApproved: true,
    });
  });

  it('queues everyone else for manual approval', () => {
    expect(releaseStatusFields(false, now)).toEqual({
      status: 'pending', published: false, approved: false, approvedAt: null, autoApproved: false,
    });
  });
});
