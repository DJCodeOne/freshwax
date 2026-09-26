// Crates listings are read from Firestore (the single source of truth) via
// lib/vinyl-listings. The listing page used to read a stale D1 copy served by
// the vinyl-api worker that only changed on a manual admin sync.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSaGetDocument = vi.fn();
const mockGetServiceAccountKey = vi.fn();

vi.mock('../lib/firebase-service-account', () => ({
  saGetDocument: (...a: unknown[]) => mockSaGetDocument(...a),
  getServiceAccountKey: (...a: unknown[]) => mockGetServiceAccountKey(...a),
}));

const {
  getPublicVinylListing, isPublicListingStatus, isPurchasableListing, sanitizeListingImages, PUBLIC_LISTING_STATUSES,
} = await import('../lib/vinyl-listings');

const env = { FIREBASE_PROJECT_ID: 'freshwax-store' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServiceAccountKey.mockReturnValue('{"sa":"key"}');
});

describe('isPublicListingStatus', () => {
  it('shows live, sold and reserved listings', () => {
    expect(PUBLIC_LISTING_STATUSES).toEqual(['published', 'sold', 'reserved']);
    for (const s of ['published', 'sold', 'reserved']) expect(isPublicListingStatus(s)).toBe(true);
  });

  it('hides draft, pending, rejected, removed and junk', () => {
    for (const s of ['draft', 'pending', 'rejected', 'removed', '', undefined, null, 42]) {
      expect(isPublicListingStatus(s)).toBe(false);
    }
  });
});

describe('isPurchasableListing', () => {
  it('only a live, non-deleted listing can be bought', () => {
    expect(isPurchasableListing({ status: 'published' })).toBe(true);
    expect(isPurchasableListing({ status: 'sold' })).toBe(false);
    expect(isPurchasableListing({ status: 'reserved' })).toBe(false);
    expect(isPurchasableListing({ status: 'published', deleted: true })).toBe(false);
    expect(isPurchasableListing(null)).toBe(false);
  });
});

describe('getPublicVinylListing', () => {
  it('reads the listing from Firestore vinylListings', async () => {
    mockSaGetDocument.mockResolvedValue({ id: 'vl_1', status: 'published', title: 'Timeless' });
    const listing = await getPublicVinylListing(env, 'vl_1');
    expect(listing).toEqual({ id: 'vl_1', status: 'published', title: 'Timeless' });
    expect(mockSaGetDocument).toHaveBeenCalledWith('{"sa":"key"}', 'freshwax-store', 'vinylListings', 'vl_1');
  });

  it('returns sold and reserved listings (shown as unavailable)', async () => {
    mockSaGetDocument.mockResolvedValue({ id: 'vl_2', status: 'sold' });
    expect(await getPublicVinylListing(env, 'vl_2')).not.toBeNull();
    mockSaGetDocument.mockResolvedValue({ id: 'vl_3', status: 'reserved' });
    expect(await getPublicVinylListing(env, 'vl_3')).not.toBeNull();
  });

  it('hides rejected, draft and soft-deleted listings (the fake vl_test_ crates case)', async () => {
    mockSaGetDocument.mockResolvedValue({ id: 'vl_test_goldie_timeless', status: 'rejected' });
    expect(await getPublicVinylListing(env, 'vl_test_goldie_timeless')).toBeNull();
    mockSaGetDocument.mockResolvedValue({ id: 'vl_4', status: 'draft' });
    expect(await getPublicVinylListing(env, 'vl_4')).toBeNull();
    mockSaGetDocument.mockResolvedValue({ id: 'vl_5', status: 'published', deleted: true });
    expect(await getPublicVinylListing(env, 'vl_5')).toBeNull();
  });

  it('returns null for a missing listing, a missing id or missing credentials', async () => {
    mockSaGetDocument.mockResolvedValue(null);
    expect(await getPublicVinylListing(env, 'nope')).toBeNull();
    expect(await getPublicVinylListing(env, '')).toBeNull();
    expect(await getPublicVinylListing(undefined, 'vl_1')).toBeNull();
    mockGetServiceAccountKey.mockReturnValue(null);
    expect(await getPublicVinylListing(env, 'vl_1')).toBeNull();
  });

  it('treats a Firestore error as not found instead of throwing', async () => {
    mockSaGetDocument.mockRejectedValue(new Error('Failed to get document: 503'));
    await expect(getPublicVinylListing(env, 'vl_1')).resolves.toBeNull();
  });
});

describe('sanitizeListingImages', () => {
  it('keeps uploaded CDN URLs and site-root paths', () => {
    expect(sanitizeListingImages([
      'https://cdn.freshwax.co.uk/vinyl/uid123/new_0_1790000000000.webp',
      '/place-holder.webp',
    ], 6)).toEqual([
      'https://cdn.freshwax.co.uk/vinyl/uid123/new_0_1790000000000.webp',
      '/place-holder.webp',
    ]);
  });

  it('drops values that could break out of an HTML attribute or aren\'t https', () => {
    expect(sanitizeListingImages([
      'https://x.test/a.webp" onerror="alert(1)',
      'https://x.test/<script>.webp',
      'javascript:alert(1)',
      'http://insecure.test/a.webp',
      '//evil.test/a.webp',
      'https://x.test/has space.webp',
      42,
      null,
      { url: 'https://x.test/a.webp' },
    ], 6)).toEqual([]);
  });

  it('caps the count and handles non-arrays', () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://cdn.freshwax.co.uk/vinyl/u/${i}.webp`);
    expect(sanitizeListingImages(urls, 6)).toHaveLength(6);
    expect(sanitizeListingImages('https://cdn.freshwax.co.uk/a.webp', 6)).toEqual([]);
    expect(sanitizeListingImages(undefined, 6)).toEqual([]);
  });
});
