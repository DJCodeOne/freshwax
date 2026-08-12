// Integration test for the real checkout price validator, driven by actual
// production release documents (dumped from D1) rather than hand-made fixtures.
// Only Firestore reads are mocked — validateAndGetPrices itself runs for real,
// which is the code path /api/stripe/create-checkout-session and
// /api/paypal/create-order use.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DUMP = path.resolve(__dirname, 'fixtures/releases.sample.json');

// Real releases, keyed by id.
const releases = new Map<string, Record<string, unknown>>(
  (JSON.parse(fs.readFileSync(DUMP, 'utf8')) as Record<string, unknown>[]).map(r => [String(r.id), r])
);

vi.mock('../lib/firebase-rest', () => ({
  getDocument: vi.fn(async (collection: string, id: string) =>
    collection === 'releases' ? releases.get(id) ?? null : null
  ),
}));

const DRUM_UNIT = 'drum_unit_recordings_FW-1786529398020';

let validateAndGetPrices: typeof import('../lib/order/stock-validation')['validateAndGetPrices'];

beforeAll(async () => {
  ({ validateAndGetPrices } = await import('../lib/order/stock-validation'));
});

describe('checkout price validation against real production releases', () => {
  it('has the real Drum Unit release loaded, priced via pricePerSale', () => {
    const r = releases.get(DRUM_UNIT)!;
    expect(r.pricePerSale).toBe(3);
    // The exact shape that broke validation: both of these are null in prod.
    expect(r.price ?? null).toBeNull();
    expect(r.digitalPrice ?? null).toBeNull();
  });

  it('prices a legitimate digital album purchase at £3', async () => {
    const { validatedItems, hasPriceMismatch } = await validateAndGetPrices([
      { id: DRUM_UNIT, releaseId: DRUM_UNIT, type: 'digital', name: 'Stamp Series Vol 1', price: 3, quantity: 1 },
    ] as never);
    expect(validatedItems[0].price).toBe(3);
    expect(hasPriceMismatch).toBe(false);
  });

  // The actual attack: tamper the cart in localStorage and pay 1p.
  it('REJECTS a tampered £0.01 digital album price and charges £3', async () => {
    const { validatedItems, hasPriceMismatch } = await validateAndGetPrices([
      { id: DRUM_UNIT, releaseId: DRUM_UNIT, type: 'digital', name: 'Stamp Series Vol 1', price: 0.01, quantity: 1 },
    ] as never);
    expect(validatedItems[0].price).toBe(3);
    expect(hasPriceMismatch).toBe(true);
  });

  it('rejects a tampered price on every live digital release in the catalogue', async () => {
    const live = [...releases.values()].filter(
      r => r.status === 'live' && Number(r.pricePerSale) > 0
    );
    expect(live.length).toBeGreaterThan(5);

    for (const r of live) {
      const id = String(r.id);
      const { validatedItems } = await validateAndGetPrices([
        { id, releaseId: id, type: 'digital', name: String(r.title), price: 0.01, quantity: 1 },
      ] as never);
      expect(validatedItems[0].price, `${r.title} accepted a tampered price`).toBeCloseTo(
        Number(r.pricePerSale),
        5
      );
    }
  });

  it('still validates track prices from the real release', async () => {
    const r = releases.get(DRUM_UNIT)!;
    const track = (r.tracks as Record<string, unknown>[])[0];
    const { validatedItems } = await validateAndGetPrices([
      {
        id: DRUM_UNIT, releaseId: DRUM_UNIT, type: 'track',
        trackId: track.id ?? 'missing-id', name: String(track.title), price: 0.01, quantity: 1,
      },
    ] as never);
    // Falls back to release.trackPrice (£1.50) when the track carries no price
    expect(validatedItems[0].price).toBe(1.5);
  });

  it('still validates vinyl at the real £12', async () => {
    const { validatedItems } = await validateAndGetPrices([
      { id: DRUM_UNIT, releaseId: DRUM_UNIT, type: 'vinyl', name: 'Stamp Series Vol 1', price: 0.01, quantity: 1 },
    ] as never);
    expect(validatedItems[0].price).toBe(12);
  });

  it('carries the resolved artistId onto the vinyl line so shipping is charged', async () => {
    // computeReleaseVinylShipping skips items with no artistId — that was the
    // £0-postage bug. Ownership now resolves from the release document.
    const { validatedItems } = await validateAndGetPrices([
      { id: DRUM_UNIT, releaseId: DRUM_UNIT, type: 'vinyl', name: 'Stamp Series Vol 1', price: 12, quantity: 1 },
    ] as never);
    expect(validatedItems[0].artistId).toBe('HVXl6a4BQ7WmSw4QemNP76Qnktm2');
  });
});
