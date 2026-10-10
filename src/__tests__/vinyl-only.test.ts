// Vinyl-only releases: sold as a physical record only. Their tracks are
// preview clips — checkout must refuse digital/track purchases, orders must
// carry no downloads, and the download endpoints must refuse the audio.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const VINYL_ONLY = {
  id: 'rel_vo', releaseName: 'Danger Chamber Dubz', vinylOnly: true, vinylRelease: true,
  vinylPrice: 25, pricePerSale: 7.99, trackPrice: 1.99, coverArtUrl: 'https://cdn.example/cover.webp',
  tracks: [{ id: 't1', trackNumber: 1, title: 'Red Handle (Z-Day Remix)', mp3Url: 'https://cdn.example/clip1.mp3' }],
};
const NORMAL = {
  id: 'rel_norm', releaseName: 'Normal EP', vinylRelease: true, vinylPrice: 15, pricePerSale: 6,
  tracks: [{ id: 'n1', trackNumber: 1, title: 'Tune', mp3Url: 'https://cdn.example/tune.mp3', wavUrl: 'https://cdn.example/tune.wav' }],
};
const docs: Record<string, Record<string, unknown>> = { rel_vo: VINYL_ONLY, rel_norm: NORMAL };

vi.mock('../lib/firebase-rest', () => ({
  getDocument: vi.fn(async (collection: string, id: string) => (collection === 'releases' ? docs[id] ?? null : null)),
}));

let validateAndGetPrices: typeof import('../lib/order/stock-validation')['validateAndGetPrices'];
let processItemsWithDownloads: typeof import('../lib/order/stock-validation')['processItemsWithDownloads'];
let isOrderItemAudioBlocked: typeof import('../lib/order/vinyl-only')['isOrderItemAudioBlocked'];

beforeAll(async () => {
  ({ validateAndGetPrices, processItemsWithDownloads } = await import('../lib/order/stock-validation'));
  ({ isOrderItemAudioBlocked } = await import('../lib/order/vinyl-only'));
});

describe('vinyl-only checkout', () => {
  it('refuses the digital release', async () => {
    const r = await validateAndGetPrices([{ id: 'rel_vo', releaseId: 'rel_vo', type: 'digital', name: 'Danger Chamber Dubz', price: 7.99, quantity: 1 }] as never);
    expect(r.validationError).toMatch(/only available on vinyl/i);
  });

  it('refuses a single track, with or without a trackId', async () => {
    for (const item of [
      { id: 'rel_vo', releaseId: 'rel_vo', type: 'track', trackId: 't1', name: 'Red Handle', price: 1.99, quantity: 1 },
      { id: 'rel_vo', releaseId: 'rel_vo', type: 'track', name: 'Red Handle', price: 1.99, quantity: 1 },
    ]) {
      const r = await validateAndGetPrices([item] as never);
      expect(r.validationError).toMatch(/only available on vinyl/i);
    }
  });

  it('still sells the record at the vinyl price', async () => {
    const r = await validateAndGetPrices([{ id: 'rel_vo', releaseId: 'rel_vo', type: 'vinyl', name: 'Danger Chamber Dubz', price: 25, quantity: 1 }] as never);
    expect(r.validationError).toBeUndefined();
    expect(r.validatedItems[0].price).toBe(25);
  });
});

describe('vinyl-only orders carry no downloads', () => {
  it('stamps the record noDigital with no download links', async () => {
    const [item] = await processItemsWithDownloads([{ id: 'rel_vo', releaseId: 'rel_vo', type: 'vinyl', name: 'Danger Chamber Dubz', price: 25, quantity: 1 }] as never);
    expect(item.noDigital).toBe(true);
    expect(item.downloads).toBeUndefined();
  });

  it('still gives normal vinyl buyers their downloads', async () => {
    const [item] = await processItemsWithDownloads([{ id: 'rel_norm', releaseId: 'rel_norm', type: 'vinyl', name: 'Normal EP', price: 15, quantity: 1 }] as never);
    expect(item.noDigital).toBeUndefined();
    expect((item.downloads as { tracks?: unknown[] })?.tracks?.length).toBe(1);
  });
});

describe('download endpoints gate', () => {
  const getRelease = async (id: string) => docs[id] ?? null;

  it('blocks items stamped noDigital', async () => {
    expect(await isOrderItemAudioBlocked({ type: 'vinyl', releaseId: 'rel_norm', noDigital: true }, getRelease)).toBe(true);
  });

  it('blocks vinyl of a release that is vinyl-only, even on an older order without the stamp', async () => {
    expect(await isOrderItemAudioBlocked({ type: 'vinyl', releaseId: 'rel_vo' }, getRelease)).toBe(true);
  });

  it('allows normal vinyl and digital purchases', async () => {
    expect(await isOrderItemAudioBlocked({ type: 'vinyl', releaseId: 'rel_norm' }, getRelease)).toBe(false);
    expect(await isOrderItemAudioBlocked({ type: 'digital', releaseId: 'rel_norm' }, getRelease)).toBe(false);
  });
});
