import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/firebase-rest', () => ({
  getDocument: vi.fn().mockResolvedValue(null),
  queryCollection: vi.fn().mockResolvedValue([]),
  setDocument: vi.fn().mockResolvedValue({ success: true }),
  updateDocument: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../lib/red5', () => ({
  buildRtmpUrl: vi.fn((key: string) => `rtmp://test/${key}`),
  buildHlsUrl: vi.fn((key: string) => `https://test/live/${key}/index.m3u8`),
  findActiveRtmpStreamForDj: vi.fn().mockResolvedValue(null),
  generateStreamKey: vi.fn(() => 'fwx_new_key_a_b'),
  initRed5Env: vi.fn(),
}));
vi.mock('../lib/pusher', () => ({ broadcastLiveStatus: vi.fn().mockResolvedValue(true) }));
vi.mock('../lib/admin', () => ({ isAdmin: vi.fn().mockResolvedValue(false) }));
vi.mock('../lib/cron-lock', () => ({
  acquireCronLock: vi.fn().mockResolvedValue(true),
  releaseCronLock: vi.fn().mockResolvedValue(undefined),
  REQUEST_LOCK_TTL_MS: 60000,
}));
vi.mock('../lib/activity-feed', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/kv-cache', () => ({ initKVCache: vi.fn() }));
vi.mock('../lib/d1-catalog', () => ({ d1UpsertSlot: vi.fn(), d1UpdateSlotStatus: vi.fn() }));
vi.mock('../lib/livestream-slots/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/livestream-slots/helpers')>();
  return {
    ...actual,
    checkDjEligible: vi.fn().mockResolvedValue({ eligible: true }),
    getSettings: vi.fn().mockResolvedValue({ allowGoLiveNow: true }),
    invalidateCache: vi.fn(),
  };
});

import { handleGoLive, handleGoLiveNow } from '../lib/livestream-slots/activation';
import { queryCollection, setDocument, updateDocument } from '../lib/firebase-rest';
import { acquireCronLock } from '../lib/cron-lock';

const mockQuery = vi.mocked(queryCollection);
const mockSet = vi.mocked(setDocument);
const mockUpdate = vi.mocked(updateDocument);

const now = new Date('2026-09-26T20:05:00Z');
const nowISO = now.toISOString();
const noop = async () => {};

// Route queryCollection by query shape: the "who is live" check vs the
// upcoming-slots read (endTime > now).
function slotsInFirestore(live: Record<string, unknown>[], upcoming: Record<string, unknown>[]) {
  mockQuery.mockImplementation(async (_c: string, opts: { filters?: { field: string }[] }) => {
    const field = opts?.filters?.[0]?.field;
    if (field === 'status') return live;
    if (field === 'endTime') return upcoming;
    return [];
  });
}

const goLive = (extra: Record<string, unknown> = {}) => handleGoLive(
  { djId: 'me', djName: 'Me', streamKey: 'fwx_me_key_a_b', broadcastMode: 'video', ...extra },
  'me', 'tok', {}, {}, now, nowISO, noop,
);

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue({ success: true } as never);
  mockUpdate.mockResolvedValue({ success: true } as never);
});

describe('go_live respects bookings', () => {
  it("refuses another DJ's booked hour and names them", async () => {
    slotsInFirestore([], [
      { id: 'theirs', djId: 'other', djName: 'Booked DJ', status: 'scheduled', startTime: '2026-09-26T20:00:00.000Z', endTime: '2026-09-26T21:00:00.000Z' },
    ]);
    const res = await goLive();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Booked DJ has booked this slot');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('runs a 2-hour booking to its end and supersedes only that booking', async () => {
    slotsInFirestore([], [
      { id: 'mine', djId: 'me', status: 'scheduled', startTime: '2026-09-26T20:00:00.000Z', endTime: '2026-09-26T22:00:00.000Z' },
      { id: 'nextWeek', djId: 'me', status: 'scheduled', startTime: '2026-10-03T20:00:00.000Z', endTime: '2026-10-03T21:00:00.000Z' },
    ]);
    const res = await goLive();
    expect(res.status).toBe(200);
    const created = mockSet.mock.calls[0][2] as Record<string, unknown>;
    expect(created.status).toBe('live');
    expect(created.endTime).toBe('2026-09-26T22:00:00.000Z');
    const superseded = mockUpdate.mock.calls.map((c) => c[1]);
    expect(superseded).toEqual(['mine']);
    expect(mockUpdate.mock.calls[0][2]).toMatchObject({ status: 'completed' });
  });

  it('still refuses when someone is live, and takes the lock with the short TTL', async () => {
    slotsInFirestore([{ id: 'l', djId: 'other', status: 'live', endTime: '2026-09-26T21:00:00.000Z' }], []);
    const res = await goLive();
    expect(res.status).toBe(400);
    expect(vi.mocked(acquireCronLock)).toHaveBeenCalledWith({}, 'slot_go_live', 60000);
  });
});

describe('go_live_now', () => {
  const goLiveNow = () => handleGoLiveNow({ djId: 'me', djName: 'Me' }, 'me', 'tok', {}, {}, now, nowISO, noop);

  it('ignores a stale live slot whose end time has passed', async () => {
    slotsInFirestore([{ id: 'stale', djId: 'other', status: 'live', endTime: '2026-09-26T19:00:00.000Z' }], []);
    const res = await goLiveNow();
    expect(res.status).toBe(200);
    expect((mockSet.mock.calls[0][2] as Record<string, unknown>).endTime).toBe('2026-09-26T21:00:00.000Z');
  });
});
