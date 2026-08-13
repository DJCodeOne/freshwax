// Integration test for the second approval path: admin/update-user-role.ts
// grants a raw roles key directly, so it must also close out any matching
// pendingRoleRequests -- the same gap that left 13 already-live partners
// sitting "pending" from Dec 2025 to Aug 2026.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryCollection = vi.fn();
const mockUpdateDocument = vi.fn();
const mockSaGetDocument = vi.fn();
const mockSaUpdateDocument = vi.fn();

vi.mock('../lib/firebase-rest', () => ({
  queryCollection: (...a: unknown[]) => mockQueryCollection(...a),
  updateDocument: (...a: unknown[]) => mockUpdateDocument(...a),
}));
vi.mock('../lib/firebase-service-account', () => ({
  saGetDocument: (...a: unknown[]) => mockSaGetDocument(...a),
  saUpdateDocument: (...a: unknown[]) => mockSaUpdateDocument(...a),
}));
vi.mock('../lib/admin', () => ({
  requireAdminAuth: async () => null, // authorised
  initAdminEnv: () => {},
}));
vi.mock('../lib/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientId: () => 'test',
  rateLimitResponse: () => new Response('rate limited', { status: 429 }),
  RateLimiters: { write: {} },
}));

const { GET } = await import('../pages/api/admin/update-user-role');

const UID = 'partner-uid-1';
const locals = { runtime: { env: {
  FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'sa@example.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----',
} } };

const call = (role: string, value: string, confirm = 'yes') => GET({
  request: new Request(`https://x/api/admin/update-user-role?userId=${UID}&role=${role}&value=${value}&confirm=${confirm}`),
  locals,
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockSaGetDocument.mockResolvedValue({ email: 'p@example.com', displayName: 'Partner', roles: {} });
  mockSaUpdateDocument.mockResolvedValue(undefined);
  mockUpdateDocument.mockResolvedValue(undefined);
  mockQueryCollection.mockResolvedValue([
    { id: `${UID}_artist`, userId: UID, roleType: 'artist', status: 'pending' },
  ]);
});

describe('update-user-role resolves pending requests', () => {
  it('closes the matching request when the role is granted', async () => {
    const res = await call('artist', 'true');
    const body = await res.json() as Record<string, unknown>;

    expect(body.resolvedRequests).toBe(1);
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'pendingRoleRequests', `${UID}_artist`,
      expect.objectContaining({ status: 'approved' })
    );
  });

  it('still writes the role itself', async () => {
    await call('artist', 'true');
    expect(mockSaUpdateDocument).toHaveBeenCalledWith(
      expect.anything(), 'p', 'users', UID,
      { roles: expect.objectContaining({ artist: true }) }
    );
  });

  // A revoke must not touch requests at all -- not resolve unrelated ones, and
  // never re-open a settled one.
  it('does NOT resolve anything when revoking a role', async () => {
    mockSaGetDocument.mockResolvedValue({ email: 'p@example.com', roles: { artist: true, vinylSeller: true } });
    const res = await call('vinylSeller', 'false');
    const body = await res.json() as Record<string, unknown>;

    expect(body.resolvedRequests).toBe(0);
    expect(mockQueryCollection).not.toHaveBeenCalled();
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('leaves a request pending when a DIFFERENT role was granted', async () => {
    mockQueryCollection.mockResolvedValue([
      { id: `${UID}_vinylSeller`, userId: UID, roleType: 'vinylSeller', status: 'pending' },
    ]);
    const res = await call('artist', 'true');
    const body = await res.json() as Record<string, unknown>;

    expect(body.resolvedRequests).toBe(0);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('does not write anything in preview mode', async () => {
    const res = await call('artist', 'true', 'no');
    const body = await res.json() as Record<string, unknown>;

    expect(body.message).toMatch(/preview/i);
    expect(mockSaUpdateDocument).not.toHaveBeenCalled();
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  // Bookkeeping must never fail the grant that already succeeded.
  it('still reports success if request resolution blows up', async () => {
    mockQueryCollection.mockRejectedValue(new Error('index missing'));
    const res = await call('artist', 'true');
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.resolvedRequests).toBe(0);
    expect(mockSaUpdateDocument).toHaveBeenCalled();
  });
});
