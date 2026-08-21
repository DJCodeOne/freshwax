// Tests for groupDigitalItemsByArtistEmail — the recipient resolution behind
// sendDigitalSaleEmails. Cart items never carry artistEmail in practice
// (0/46 items across all historical orders), so recipients must resolve via
// release → artists docs exactly like the payout path, or labels silently
// hear nothing about their sales.
import { describe, it, expect, vi } from 'vitest';
import { groupDigitalItemsByArtistEmail } from '../lib/order/emails';
import type { CartItem } from '../lib/order/types';

type Doc = Record<string, unknown> | null;

function stubFetcher(docs: Record<string, Doc>) {
  const calls: string[] = [];
  const fetchDoc = vi.fn(async (collection: string, id: string): Promise<Doc> => {
    calls.push(`${collection}/${id}`);
    return docs[`${collection}/${id}`] ?? null;
  });
  return { fetchDoc, calls };
}

describe('groupDigitalItemsByArtistEmail', () => {
  it('resolves via release.artistId -> artists doc email (label routing)', async () => {
    const { fetchDoc } = stubFetcher({
      'releases/rel-1': { artistId: 'uid-label' },
      'artists/uid-label': { email: 'label@example.com' },
    });
    const items: CartItem[] = [{ type: 'track', releaseId: 'rel-1', name: 'Tune', price: 2.5 }];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(Object.keys(grouped)).toEqual(['label@example.com']);
    expect(grouped['label@example.com']).toHaveLength(1);
  });

  it('falls back to release.userId when artistId is empty', async () => {
    const { fetchDoc } = stubFetcher({
      'releases/rel-2': { artistId: '', userId: 'uid-owner' },
      'artists/uid-owner': { email: 'owner@example.com' },
    });
    const items: CartItem[] = [{ type: 'track', releaseId: 'rel-2', name: 'B-side' }];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(Object.keys(grouped)).toEqual(['owner@example.com']);
  });

  it('fans a payoutSplits release out to every listed owner', async () => {
    const { fetchDoc } = stubFetcher({
      'releases/rel-split': { artistId: 'uid-a', payoutSplits: [
        { artistId: 'uid-a', percentage: 50 },
        { artistId: 'uid-b', percentage: 50 },
      ] },
      'artists/uid-a': { email: 'a@example.com' },
      'artists/uid-b': { email: 'b@example.com' },
    });
    const items: CartItem[] = [{ type: 'track', releaseId: 'rel-split', name: 'Warrior' }];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(Object.keys(grouped).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(grouped['a@example.com'][0].name).toBe('Warrior');
    expect(grouped['b@example.com'][0].name).toBe('Warrior');
  });

  it('keeps a cart-provided artistEmail without fetching docs', async () => {
    const { fetchDoc } = stubFetcher({});
    const items = [{ type: 'track', releaseId: 'rel-x', artistEmail: 'direct@example.com' } as CartItem];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(Object.keys(grouped)).toEqual(['direct@example.com']);
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('prefers item.artistId over release.artistId', async () => {
    const { fetchDoc } = stubFetcher({
      'releases/rel-3': { artistId: 'uid-release' },
      'artists/uid-item': { email: 'item@example.com' },
    });
    const items: CartItem[] = [{ type: 'track', releaseId: 'rel-3', artistId: 'uid-item' }];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(Object.keys(grouped)).toEqual(['item@example.com']);
  });

  it('skips items whose release resolves no payee, without throwing', async () => {
    const { fetchDoc } = stubFetcher({
      'releases/rel-orphan': { labelName: 'Nyctophilia Recordings' },
    });
    const items: CartItem[] = [{ type: 'digital', releaseId: 'rel-orphan', name: 'Embrace The Darkness' }];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(grouped).toEqual({});
  });

  it('skips artists whose doc is missing or has no email', async () => {
    const { fetchDoc } = stubFetcher({
      'releases/rel-4': { artistId: 'uid-noemail' },
      'artists/uid-noemail': { name: 'No Email' },
      'releases/rel-5': { artistId: 'uid-missing' },
    });
    const items: CartItem[] = [
      { type: 'track', releaseId: 'rel-4' },
      { type: 'track', releaseId: 'rel-5' },
    ];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(grouped).toEqual({});
  });

  it('groups multiple items under one artist and caches doc fetches', async () => {
    const { fetchDoc, calls } = stubFetcher({
      'releases/rel-ul-1': { artistId: 'uid-ul' },
      'releases/rel-ul-2': { artistId: 'uid-ul' },
      'artists/uid-ul': { email: 'ul@example.com' },
    });
    const items: CartItem[] = [
      { type: 'track', releaseId: 'rel-ul-1', name: 'T1' },
      { type: 'track', releaseId: 'rel-ul-1', name: 'T2' },
      { type: 'digital', releaseId: 'rel-ul-2', name: 'EP' },
    ];
    const grouped = await groupDigitalItemsByArtistEmail(items, fetchDoc);
    expect(grouped['ul@example.com'].map((i) => i.name)).toEqual(['T1', 'T2', 'EP']);
    expect(calls.filter((c) => c === 'releases/rel-ul-1')).toHaveLength(1);
    expect(calls.filter((c) => c === 'artists/uid-ul')).toHaveLength(1);
  });

  it('survives a fetch failure for one item and still resolves the rest', async () => {
    const failing = vi.fn(async (collection: string, id: string): Promise<Doc> => {
      if (id === 'rel-bad') throw new Error('boom');
      const docs: Record<string, Doc> = {
        'releases/rel-good': { artistId: 'uid-g' },
        'artists/uid-g': { email: 'g@example.com' },
      };
      return docs[`${collection}/${id}`] ?? null;
    });
    const items: CartItem[] = [
      { type: 'track', releaseId: 'rel-bad', name: 'Broken' },
      { type: 'track', releaseId: 'rel-good', name: 'Fine' },
    ];
    const grouped = await groupDigitalItemsByArtistEmail(items, failing);
    expect(Object.keys(grouped)).toEqual(['g@example.com']);
  });
});
