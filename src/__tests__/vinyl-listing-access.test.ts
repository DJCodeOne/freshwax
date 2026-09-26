// GET /api/vinyl/listing used to return any listing — and a seller's whole
// list, drafts included — to anyone who knew the listing id or the seller's
// uid (which is public in Crates collection links). Drafts, pending, rejected
// and removed listings are now private to their seller.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDocument = vi.fn();
const mockQueryCollection = vi.fn();
const mockVerifyRequestUser = vi.fn();

vi.mock('../lib/firebase-rest', () => ({
  getDocument: (...a: unknown[]) => mockGetDocument(...a),
  queryCollection: (...a: unknown[]) => mockQueryCollection(...a),
  verifyRequestUser: (...a: unknown[]) => mockVerifyRequestUser(...a),
  setDocument: vi.fn(),
  updateDocument: vi.fn(),
}));
vi.mock('../lib/firebase-service-account', () => ({
  saGetDocument: vi.fn(),
  getServiceAccountKey: vi.fn(),
}));
vi.mock('../lib/d1-catalog', () => ({ d1GetVinylSeller: vi.fn() }));
vi.mock('../lib/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientId: () => 'test',
  rateLimitResponse: () => new Response('rate limited', { status: 429 }),
}));

const { GET } = await import('../pages/api/vinyl/listing');

const SELLER = 'seller-uid-1';
const call = (qs: string) => GET({ request: new Request(`https://x/api/vinyl/listing/?${qs}`) } as never);
const asUser = (userId: string | null) => mockVerifyRequestUser.mockResolvedValue(userId ? { userId } : { userId: null, error: 'Missing' });

beforeEach(() => {
  vi.clearAllMocks();
  asUser(null);
  mockQueryCollection.mockResolvedValue([
    { id: 'vl_a', sellerId: SELLER, status: 'draft', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'vl_b', sellerId: SELLER, status: 'published', createdAt: '2026-09-02T00:00:00Z' },
  ]);
});

describe('GET ?id= (single listing)', () => {
  it('returns a public listing to anyone, without checking auth', async () => {
    mockGetDocument.mockResolvedValue({ id: 'vl_b', sellerId: SELLER, status: 'published' });
    const res = await call('id=vl_b');
    expect(res.status).toBe(200);
    expect(mockVerifyRequestUser).not.toHaveBeenCalled();
  });

  it('hides a draft from anonymous visitors with the same 404 as a missing listing', async () => {
    mockGetDocument.mockResolvedValue({ id: 'vl_a', sellerId: SELLER, status: 'draft' });
    const res = await call('id=vl_a');
    expect(res.status).toBe(404);
  });

  it('hides a draft from other signed-in users', async () => {
    mockGetDocument.mockResolvedValue({ id: 'vl_a', sellerId: SELLER, status: 'draft' });
    asUser('someone-else');
    expect((await call('id=vl_a')).status).toBe(404);
  });

  it('returns a draft to its own seller', async () => {
    mockGetDocument.mockResolvedValue({ id: 'vl_a', sellerId: SELLER, status: 'draft' });
    asUser(SELLER);
    const res = await call('id=vl_a');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.listing as Record<string, unknown>).id).toBe('vl_a');
  });

  it('treats rejected, removed and soft-deleted listings as private too', async () => {
    for (const doc of [
      { id: 'vl_r', sellerId: SELLER, status: 'rejected' },
      { id: 'vl_x', sellerId: SELLER, status: 'removed' },
      { id: 'vl_d', sellerId: SELLER, status: 'published', deleted: true },
    ]) {
      mockGetDocument.mockResolvedValue(doc);
      asUser(null);
      expect((await call(`id=${doc.id}`)).status).toBe(404);
    }
  });
});

describe('GET ?sellerId= (a seller\'s own list, drafts included)', () => {
  it('requires authentication', async () => {
    const res = await call(`sellerId=${SELLER}`);
    expect(res.status).toBe(401);
    expect(mockQueryCollection).not.toHaveBeenCalled();
  });

  it('refuses another user', async () => {
    asUser('someone-else');
    const res = await call(`sellerId=${SELLER}`);
    expect(res.status).toBe(403);
    expect(mockQueryCollection).not.toHaveBeenCalled();
  });

  it('returns the seller their own listings, newest first', async () => {
    asUser(SELLER);
    const res = await call(`sellerId=${SELLER}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { listings: Array<{ id: string }> };
    expect(body.listings.map((l) => l.id)).toEqual(['vl_b', 'vl_a']);
    expect(mockQueryCollection).toHaveBeenCalledWith('vinylListings', expect.objectContaining({
      filters: [{ field: 'sellerId', op: 'EQUAL', value: SELLER }],
    }));
  });
});
