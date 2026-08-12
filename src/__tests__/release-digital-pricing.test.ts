import { describe, it, expect } from 'vitest';
import { resolveReleaseDigitalPrices } from '../lib/order/stock-validation';

// Guards the bug where the checkout validator read release.price /
// release.digitalPrice — both null on every real release — and silently fell
// back to the CLIENT-supplied price, validating nothing.
describe('resolveReleaseDigitalPrices', () => {
  it('uses pricePerSale as the album price', () => {
    const r = { pricePerSale: 3, trackPrice: 1.5, tracks: [{}, {}] };
    expect(resolveReleaseDigitalPrices(r).albumPrice).toBe(3);
  });

  it('does not fall back to a null price/digitalPrice', () => {
    // Exactly the shape of every release in production
    const r = { price: null, digitalPrice: null, pricePerSale: 4.5, trackPrice: 2.5, tracks: [{}, {}] };
    expect(resolveReleaseDigitalPrices(r).albumPrice).toBe(4.5);
  });

  it('falls back to trackPrice * trackCount when no album price is set', () => {
    const r = { pricePerSale: 0, trackPrice: 1.25, tracks: [{}, {}, {}] };
    expect(resolveReleaseDigitalPrices(r).albumPrice).toBeCloseTo(3.75, 5);
  });

  it('returns the track price', () => {
    expect(resolveReleaseDigitalPrices({ trackPrice: 1.5, tracks: [{}] }).trackPrice).toBe(1.5);
  });

  it('defaults the track price to 1.00 when absent', () => {
    expect(resolveReleaseDigitalPrices({ tracks: [{}] }).trackPrice).toBe(1);
  });

  it('applies a sale discount to both album and track', () => {
    const r = { pricePerSale: 10, trackPrice: 2, saleDiscount: 25, tracks: [{}, {}] };
    const { albumPrice, trackPrice } = resolveReleaseDigitalPrices(r);
    expect(albumPrice).toBeCloseTo(7.5, 5);
    expect(trackPrice).toBeCloseTo(1.5, 5);
  });

  it('matches the item page formula so discounted buys are not flagged as mismatches', () => {
    // item/[id].astro: originalDigitalPrice * (1 - saleDiscount / 100)
    const pricePerSale = 8.5, saleDiscount = 15;
    const itemPagePrice = pricePerSale * (1 - saleDiscount / 100);
    const server = resolveReleaseDigitalPrices({ pricePerSale, trackPrice: 2.5, saleDiscount, tracks: [{}] });
    expect(Math.abs(server.albumPrice - itemPagePrice)).toBeLessThan(0.01);
  });

  it('ignores a zero/absent discount', () => {
    expect(resolveReleaseDigitalPrices({ pricePerSale: 6, saleDiscount: 0, tracks: [{}] }).albumPrice).toBe(6);
  });

  it('returns 0 for a release with no pricing at all (caller falls back)', () => {
    expect(resolveReleaseDigitalPrices({ tracks: [] }).albumPrice).toBe(0);
  });

  it('handles string-typed numbers from Firestore', () => {
    const r = { pricePerSale: '3' as unknown as number, trackPrice: '1.5' as unknown as number, tracks: [{}, {}] };
    expect(resolveReleaseDigitalPrices(r).albumPrice).toBe(3);
  });

  it('prices the real Drum Unit release at its listed £3', () => {
    const r = { pricePerSale: 3, trackPrice: 1.5, price: null, digitalPrice: null, tracks: [{}, {}] };
    const { albumPrice, trackPrice } = resolveReleaseDigitalPrices(r);
    expect(albumPrice).toBe(3);
    expect(trackPrice).toBe(1.5);
  });
});
