import { describe, it, expect } from 'vitest';
import { computeReleaseVinylShipping } from '../lib/order/shipping-rules';
import type { CartItem } from '../lib/order/types';

// Helper to build a minimal release-vinyl cart item.
function vinyl(overrides: Partial<CartItem> = {}): CartItem {
  return {
    type: 'vinyl',
    releaseId: 'rel_1',
    artistId: 'artist_1',
    artist: 'Hangry Records',
    quantity: 1,
    price: 15,
    ...overrides,
  } as CartItem;
}

describe('computeReleaseVinylShipping — per-additional-record rule', () => {
  it('charges the single UK rate for one record (no additional)', () => {
    const { total, breakdown } = computeReleaseVinylShipping([vinyl({ vinylShippingUK: 4.99 })], 'UK');
    expect(total).toBe(4.99);
    expect(breakdown.artist_1.amount).toBe(4.99);
  });

  it('charges single + 50p default for a two-record set (same artist)', () => {
    const items = [
      vinyl({ vinylShippingUK: 4.99, vinylPartId: 'part-1' }),
      vinyl({ vinylShippingUK: 4.99, vinylPartId: 'part-2' }),
    ];
    const { total, breakdown } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(5.49); // 4.99 + 0.50
    expect(breakdown.artist_1.amount).toBe(5.49);
  });

  it('uses the seller-set additional rate when provided', () => {
    const items = [
      vinyl({ vinylShippingUK: 4.99, vinylShippingAdditional: 1.0, vinylPartId: 'part-1' }),
      vinyl({ vinylShippingUK: 4.99, vinylShippingAdditional: 1.0, vinylPartId: 'part-2' }),
    ];
    const { total } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(5.99); // 4.99 + 1.00
  });

  it('charges 50p per extra record across three records', () => {
    const items = [
      vinyl({ vinylShippingUK: 4.99, vinylPartId: 'part-1' }),
      vinyl({ vinylShippingUK: 4.99, vinylPartId: 'part-2' }),
      vinyl({ vinylShippingUK: 4.99, vinylPartId: 'part-3' }),
    ];
    const { total } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(5.99); // 4.99 + 0.50 + 0.50
  });

  it('counts quantity > 1 of a single line as additional records', () => {
    const { total } = computeReleaseVinylShipping([vinyl({ vinylShippingUK: 4.99, quantity: 3 })], 'UK');
    expect(total).toBe(5.99); // 4.99 + 0.50*2
  });

  it('falls back to the £4.99 UK floor when no rate set, +50p per extra', () => {
    const items = [vinyl({ vinylPartId: 'part-1' }), vinyl({ vinylPartId: 'part-2' })];
    const { total } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(5.49);
  });

  it('uses the EU single floor (£9.99) + 50p per extra', () => {
    const items = [vinyl({ vinylPartId: 'part-1' }), vinyl({ vinylPartId: 'part-2' })];
    const { total } = computeReleaseVinylShipping(items, 'EU');
    expect(total).toBe(10.49); // 9.99 + 0.50
  });

  it('uses the international single floor (£14.99) + 50p per extra', () => {
    const items = [vinyl({ vinylPartId: 'part-1' }), vinyl({ vinylPartId: 'part-2' })];
    const { total } = computeReleaseVinylShipping(items, 'INTL');
    expect(total).toBe(15.49); // 14.99 + 0.50
  });

  it('falls back to the artist-account rate when the release rate is unset', () => {
    const { total } = computeReleaseVinylShipping([vinyl({ artistVinylShippingUK: 6.0, artistVinylShippingAdditional: 0.75 })], 'UK');
    expect(total).toBe(6.0);
  });

  it('charges each artist independently (first record single, rest additional)', () => {
    const items = [
      vinyl({ artistId: 'a1', vinylShippingUK: 4.99, vinylPartId: 'part-1' }),
      vinyl({ artistId: 'a1', vinylShippingUK: 4.99, vinylPartId: 'part-2' }),
      vinyl({ artistId: 'a2', vinylShippingUK: 4.99 }),
    ];
    const { total, breakdown } = computeReleaseVinylShipping(items, 'UK');
    expect(breakdown.a1.amount).toBe(5.49);
    expect(breakdown.a2.amount).toBe(4.99);
    expect(total).toBe(10.48);
  });

  it('reads the create-order server* field variant too', () => {
    const items = [
      vinyl({ serverVinylShippingUK: 4.99, serverVinylShippingAdditional: 0.5, vinylPartId: 'part-1' } as Partial<CartItem>),
      vinyl({ serverVinylShippingUK: 4.99, serverVinylShippingAdditional: 0.5, vinylPartId: 'part-2' } as Partial<CartItem>),
    ];
    const { total } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(5.49);
  });

  it('skips crate items (sellerId, no releaseId)', () => {
    const items = [
      { type: 'vinyl', sellerId: 'seller_1', cratesShippingCost: 3, quantity: 1 } as CartItem,
      vinyl({ vinylShippingUK: 4.99 }),
    ];
    const { total, breakdown } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(4.99); // only the release vinyl, crate excluded
    expect(Object.keys(breakdown)).toEqual(['artist_1']);
  });

  it('returns zero for a basket with no release vinyl', () => {
    const { total, breakdown } = computeReleaseVinylShipping([{ type: 'digital', id: 'd1' } as CartItem], 'UK');
    expect(total).toBe(0);
    expect(breakdown).toEqual({});
  });

  it('treats free shipping (£0 single) correctly, still adds 50p extras', () => {
    const items = [
      vinyl({ vinylShippingUK: 0, vinylPartId: 'part-1' }),
      vinyl({ vinylShippingUK: 0, vinylPartId: 'part-2' }),
    ];
    const { total } = computeReleaseVinylShipping(items, 'UK');
    expect(total).toBe(0.5); // 0 + 0.50
  });
});
