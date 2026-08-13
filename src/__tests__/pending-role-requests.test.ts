import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryCollection = vi.fn();
const mockUpdateDocument = vi.fn();

vi.mock('../lib/firebase-rest', () => ({
  queryCollection: (...args: unknown[]) => mockQueryCollection(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
}));

const { grantedRoleKey, resolvePendingRoleRequests } = await import('../lib/roles/pending-requests');

const req = (roleType: string, id = `u1_${roleType}`) => ({ id, userId: 'u1', roleType, status: 'pending' });

beforeEach(() => {
  mockQueryCollection.mockReset();
  mockUpdateDocument.mockReset();
  mockUpdateDocument.mockResolvedValue(undefined);
});

describe('grantedRoleKey', () => {
  it('maps artist and dj to the artist role', () => {
    expect(grantedRoleKey('artist')).toBe('artist');
    expect(grantedRoleKey('dj')).toBe('artist');
  });

  it('maps every merch spelling to merchSupplier', () => {
    // The request form says "merchSeller" but the role that exists is merchSupplier.
    expect(grantedRoleKey('merchSeller')).toBe('merchSupplier');
    expect(grantedRoleKey('merch')).toBe('merchSupplier');
    expect(grantedRoleKey('merchSupplier')).toBe('merchSupplier');
  });

  it('maps vinylSeller to itself', () => {
    expect(grantedRoleKey('vinylSeller')).toBe('vinylSeller');
  });

  it('returns null for unknown, empty and missing roleTypes', () => {
    expect(grantedRoleKey('wizard')).toBeNull();
    expect(grantedRoleKey('')).toBeNull();
    expect(grantedRoleKey(undefined)).toBeNull();
    expect(grantedRoleKey(null)).toBeNull();
  });
});

describe('resolvePendingRoleRequests', () => {
  it('resolves a request whose role the user now holds', async () => {
    mockQueryCollection.mockResolvedValue([req('artist')]);
    const n = await resolvePendingRoleRequests('u1', { artist: true });
    expect(n).toBe(1);
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'pendingRoleRequests', 'u1_artist',
      expect.objectContaining({ status: 'approved' })
    );
  });

  it('resolves a merchSeller request when merchSupplier was granted', async () => {
    mockQueryCollection.mockResolvedValue([req('merchSeller')]);
    expect(await resolvePendingRoleRequests('u1', { merchSupplier: true })).toBe(1);
  });

  // The gate. approve-partner.ts grants artist + merchSupplier only, so a
  // vinylSeller request must survive and stay visible in the Approvals tab.
  it('leaves a request pending when its role was NOT granted', async () => {
    mockQueryCollection.mockResolvedValue([req('vinylSeller')]);
    const n = await resolvePendingRoleRequests('u1', { artist: true, merchSupplier: true });
    expect(n).toBe(0);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('resolves only the granted subset of a mixed batch', async () => {
    mockQueryCollection.mockResolvedValue([req('artist'), req('merchSeller'), req('vinylSeller')]);
    const n = await resolvePendingRoleRequests('u1', { artist: true, merchSupplier: true });
    expect(n).toBe(2);
    const touched = mockUpdateDocument.mock.calls.map(c => c[1]);
    expect(touched).toEqual(['u1_artist', 'u1_merchSeller']);
    expect(touched).not.toContain('u1_vinylSeller');
  });

  it('treats a falsy or absent role as not granted', async () => {
    mockQueryCollection.mockResolvedValue([req('artist'), req('merchSeller')]);
    const n = await resolvePendingRoleRequests('u1', { artist: false });
    expect(n).toBe(0);
  });

  it('ignores a truthy-but-not-true role value', async () => {
    // roles.artist === 'yes' must not count as granted.
    mockQueryCollection.mockResolvedValue([req('artist')]);
    expect(await resolvePendingRoleRequests('u1', { artist: 'yes' })).toBe(0);
  });

  it('leaves unmapped roleTypes alone', async () => {
    mockQueryCollection.mockResolvedValue([req('wizard')]);
    expect(await resolvePendingRoleRequests('u1', { artist: true, wizard: true })).toBe(0);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('queries only that user\'s pending requests', async () => {
    mockQueryCollection.mockResolvedValue([]);
    await resolvePendingRoleRequests('u1', { artist: true });
    const opts = mockQueryCollection.mock.calls[0][1];
    expect(opts.filters).toEqual(expect.arrayContaining([
      { field: 'userId', op: 'EQUAL', value: 'u1' },
      { field: 'status', op: 'EQUAL', value: 'pending' },
    ]));
  });

  it('no-ops on empty userId without querying', async () => {
    expect(await resolvePendingRoleRequests('', { artist: true })).toBe(0);
    expect(mockQueryCollection).not.toHaveBeenCalled();
  });

  it('handles no pending requests', async () => {
    mockQueryCollection.mockResolvedValue([]);
    expect(await resolvePendingRoleRequests('u1', { artist: true })).toBe(0);
  });

  // Bookkeeping must never roll back a successful grant.
  it('swallows a query failure', async () => {
    mockQueryCollection.mockRejectedValue(new Error('index missing'));
    await expect(resolvePendingRoleRequests('u1', { artist: true })).resolves.toBe(0);
  });

  it('swallows a write failure', async () => {
    mockQueryCollection.mockResolvedValue([req('artist')]);
    mockUpdateDocument.mockRejectedValue(new Error('conflict'));
    await expect(resolvePendingRoleRequests('u1', { artist: true })).resolves.toBe(0);
  });
});
