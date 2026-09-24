// The retry-payouts cron (called 6-hourly by the freshwax-cron worker) moves
// real money via Stripe transfers / PayPal payouts. Operator policy (Aug 2026)
// is that ALL payouts are manual unless PAYOUTS_AUTO_TRANSFER=true, but this
// cron was missed by that change — it only stayed dormant because its query
// used an array-shaped orderBy that made Firestore 400 and return []. These
// tests pin the explicit gate so fixing the query can never start paying out.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryCollection = vi.fn();
const mockAcquireCronLock = vi.fn();
const mockReleaseCronLock = vi.fn();

vi.mock('../lib/firebase-rest', () => ({
  queryCollection: (...a: unknown[]) => mockQueryCollection(...a),
  updateDocument: vi.fn(),
  addDocument: vi.fn(),
  getDocument: vi.fn(),
  updateDocumentConditional: vi.fn(),
  clearCache: vi.fn(),
  atomicIncrement: vi.fn(),
}));
vi.mock('../lib/cron-lock', () => ({
  acquireCronLock: (...a: unknown[]) => mockAcquireCronLock(...a),
  releaseCronLock: (...a: unknown[]) => mockReleaseCronLock(...a),
}));
vi.mock('../lib/payout-emails', () => ({ sendPayoutCompletedEmail: vi.fn() }));
vi.mock('../lib/paypal-payouts', () => ({ createPayout: vi.fn(), getPayPalConfig: () => null }));
vi.mock('../lib/admin', () => ({ verifyAdminKey: () => false }));

const { POST } = await import('../pages/api/cron/retry-payouts');

const call = (env: Record<string, unknown>) => POST({
  request: new Request('https://x/api/cron/retry-payouts/', {
    method: 'POST',
    headers: { Authorization: 'Bearer cron-secret' },
  }),
  locals: { runtime: { env: { CRON_SECRET: 'cron-secret', STRIPE_SECRET_KEY: 'sk_test_x', DB: {}, ...env } } },
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireCronLock.mockResolvedValue(true);
  mockReleaseCronLock.mockResolvedValue(undefined);
  mockQueryCollection.mockResolvedValue([]);
});

describe('retry-payouts cron respects the manual-payouts policy', () => {
  it('does nothing when PAYOUTS_AUTO_TRANSFER is unset (the production default)', async () => {
    const res = await call({});
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(mockQueryCollection).not.toHaveBeenCalled();
    expect(mockAcquireCronLock).not.toHaveBeenCalled();
  });

  it('treats any value other than "true" as off', async () => {
    const res = await call({ PAYOUTS_AUTO_TRANSFER: 'false' });
    const body = await res.json() as Record<string, unknown>;
    expect(body.skipped).toBe(true);
    expect(mockQueryCollection).not.toHaveBeenCalled();
  });

  it('still rejects unauthenticated calls first', async () => {
    const res = await POST({
      request: new Request('https://x/api/cron/retry-payouts/', { method: 'POST' }),
      locals: { runtime: { env: {} } },
    } as never);
    expect(res.status).toBe(401);
    expect(mockQueryCollection).not.toHaveBeenCalled();
  });

  it('queries retryable payouts only when PAYOUTS_AUTO_TRANSFER=true, without the orderBy that used to 400', async () => {
    const res = await call({ PAYOUTS_AUTO_TRANSFER: 'true' });

    expect(res.status).toBe(200);
    expect(mockQueryCollection).toHaveBeenCalledWith('pendingPayouts', expect.objectContaining({
      filters: [{ field: 'status', op: 'IN', value: ['retry_pending', 'awaiting_connect'] }],
    }));
    const opts = mockQueryCollection.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.orderBy).toBeUndefined();
  });
});
