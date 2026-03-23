import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing modules
vi.mock('../lib/firebase-rest', () => ({
  getDocument: vi.fn(),
  queryCollection: vi.fn().mockResolvedValue([]),
  setDocument: vi.fn(),
  updateDocument: vi.fn(),
}));

vi.mock('../lib/red5', () => ({
  buildRtmpUrl: vi.fn((key: string) => `rtmp://test/${key}`),
  buildHlsUrl: vi.fn((key: string) => `https://test/live/${key}/index.m3u8`),
  generateStreamKey: vi.fn(() => 'mock-stream-key'),
  initRed5Env: vi.fn(),
}));

vi.mock('../lib/pusher', () => ({
  broadcastLiveStatus: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/admin', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  requireAdminAuth: vi.fn(),
  initAdminEnv: vi.fn(),
}));

vi.mock('../lib/cron-lock', () => ({
  acquireCronLock: vi.fn().mockResolvedValue(true),
  releaseCronLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/kv-cache', () => ({
  initKVCache: vi.fn(),
}));

vi.mock('../lib/d1-catalog', () => ({
  d1UpsertSlot: vi.fn(),
  d1UpdateSlotStatus: vi.fn(),
}));

import { handleBook, handleCancel, handleUpdateSlot } from '../lib/livestream-slots/booking';
import { SLOT_DURATIONS } from '../lib/livestream-slots/helpers';

import { getDocument, queryCollection, setDocument, updateDocument } from '../lib/firebase-rest';
import { isAdmin } from '../lib/admin';
import { acquireCronLock, releaseCronLock } from '../lib/cron-lock';

const mockGetDocument = vi.mocked(getDocument);
const mockQueryCollection = vi.mocked(queryCollection);
const mockSetDocument = vi.mocked(setDocument);
const mockUpdateDocument = vi.mocked(updateDocument);
const mockIsAdmin = vi.mocked(isAdmin);
const mockAcquireCronLock = vi.mocked(acquireCronLock);
const mockReleaseCronLock = vi.mocked(releaseCronLock);

// Helper to parse JSON Response body
async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

const now = new Date('2025-06-15T12:00:00Z');
const nowISO = now.toISOString();
const futureStart = '2025-06-15T14:00:00Z'; // 2 hours from now

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCollection.mockResolvedValue([]);
  mockIsAdmin.mockResolvedValue(false);
  mockAcquireCronLock.mockResolvedValue(true);
  mockReleaseCronLock.mockResolvedValue(undefined);
  mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });
  mockUpdateDocument.mockResolvedValue({ success: true });
  // Default: no subscription limits
  mockGetDocument.mockResolvedValue(null);
});

// =============================================
// Slot validation
// =============================================
describe('handleBook — slot validation', () => {
  it('rejects booking in the past beyond tolerance', async () => {
    const pastStart = '2025-06-15T11:50:00Z'; // 10 min in the past
    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: pastStart, duration: 60 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('past');
  });

  it('rejects invalid duration', async () => {
    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: futureStart, duration: 15 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('Invalid duration');
  });

  it('rejects missing required fields', async () => {
    const response = await handleBook(
      { djId: 'dj1' },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('Missing required fields');
  });

  it('rejects when DJ ID does not match auth user', async () => {
    const response = await handleBook(
      { djId: 'other_dj', djName: 'Other', startTime: futureStart, duration: 60 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(403);
  });

  it('detects time conflicts with existing slots', async () => {
    // Existing slot overlaps with requested time
    mockQueryCollection.mockResolvedValueOnce([
      {
        djId: 'other_dj',
        djName: 'OtherDJ',
        startTime: '2025-06-15T13:30:00Z',
        endTime: '2025-06-15T14:30:00Z',
        status: 'scheduled',
      },
    ]);

    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: futureStart, duration: 60 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('conflicts');
  });

  it('accepts valid SLOT_DURATIONS', () => {
    expect(SLOT_DURATIONS).toEqual([30, 45, 60, 120, 180, 240]);
  });

  it('rejects when booking system is busy (lock not acquired)', async () => {
    mockAcquireCronLock.mockResolvedValueOnce(false);

    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: futureStart, duration: 60 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('busy');
  });
});

// =============================================
// Booking creation
// =============================================
describe('handleBook — successful booking', () => {
  it('creates a valid booking and returns slot data', async () => {
    mockQueryCollection.mockResolvedValueOnce([]); // No conflicts

    const response = await handleBook(
      {
        djId: 'dj1',
        djName: 'TestDJ',
        djAvatar: 'https://example.com/avatar.jpg',
        startTime: futureStart,
        duration: 60,
        title: 'Jungle Session',
        genre: 'Jungle',
        description: 'A live jungle mix',
      },
      'dj1', 'token123', null, now, nowISO
    );

    expect(response.status).toBe(200);
    const body = await parseResponse(response);
    expect(body.message).toBe('Slot booked successfully');
    expect(body.slot).toBeDefined();
    expect(body.streamKey).toBeDefined();

    const slot = body.slot as Record<string, unknown>;
    expect(slot.djId).toBe('dj1');
    expect(slot.djName).toBe('TestDJ');
    expect(slot.title).toBe('Jungle Session');
    expect(slot.genre).toBe('Jungle');
    expect(slot.status).toBe('scheduled');
    expect(slot.duration).toBe(60);

    // Verify setDocument was called
    expect(mockSetDocument).toHaveBeenCalledWith(
      'livestreamSlots',
      expect.any(String),
      expect.objectContaining({
        djId: 'dj1',
        djName: 'TestDJ',
        status: 'scheduled',
        duration: 60,
      }),
      'token123'
    );

    // Verify lock was acquired and released
    expect(mockAcquireCronLock).toHaveBeenCalledWith(null, 'slot_booking');
    expect(mockReleaseCronLock).toHaveBeenCalledWith(null, 'slot_booking');
  });

  it('uses default title and genre when not provided', async () => {
    mockQueryCollection.mockResolvedValueOnce([]);

    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: futureStart, duration: 30 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(200);
    const body = await parseResponse(response);
    const slot = body.slot as Record<string, unknown>;
    expect(slot.title).toBe('TestDJ Live');
    expect(slot.genre).toBe('Jungle / D&B');
  });

  it('skips own scheduled slot during conflict check (rebooking)', async () => {
    // DJ's own scheduled slot in the same time range — should not conflict
    mockQueryCollection.mockResolvedValueOnce([
      {
        djId: 'dj1',
        djName: 'TestDJ',
        startTime: futureStart,
        endTime: '2025-06-15T15:00:00Z',
        status: 'scheduled',
      },
    ]);

    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: futureStart, duration: 60 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(200);
  });
});

// =============================================
// Duplicate rejection
// =============================================
describe('handleBook — duplicate/conflict rejection', () => {
  it('rejects when another DJ has a live slot in the same window', async () => {
    mockQueryCollection.mockResolvedValueOnce([
      {
        djId: 'other_dj',
        djName: 'LiveDJ',
        startTime: '2025-06-15T13:00:00Z',
        endTime: '2025-06-15T15:00:00Z',
        status: 'live',
      },
    ]);

    const response = await handleBook(
      { djId: 'dj1', djName: 'TestDJ', startTime: futureStart, duration: 60 },
      'dj1', null, null, now, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('conflicts');
    expect(body.error).toContain('LiveDJ');

    // Lock should be released on conflict
    expect(mockReleaseCronLock).toHaveBeenCalled();
  });
});

// =============================================
// Slot cancellation
// =============================================
describe('handleCancel', () => {
  it('cancels a slot owned by the authenticated user', async () => {
    mockGetDocument.mockResolvedValueOnce({
      djId: 'dj1',
      status: 'scheduled',
      streamKey: 'old-key',
    });

    const response = await handleCancel(
      { slotId: 'slot1' },
      'dj1', null, null, nowISO
    );

    expect(response.status).toBe(200);
    const body = await parseResponse(response);
    expect(body.message).toBe('Slot cancelled');

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'livestreamSlots', 'slot1',
      expect.objectContaining({
        status: 'cancelled',
        streamKey: null,
        previousDjId: 'dj1',
        previousStreamKey: 'old-key',
      }),
      null
    );
  });

  it('rejects missing slotId', async () => {
    const response = await handleCancel({}, 'dj1', null, null, nowISO);
    expect(response.status).toBe(400);
  });

  it('returns 404 for non-existent slot', async () => {
    mockGetDocument.mockResolvedValueOnce(null);

    const response = await handleCancel(
      { slotId: 'missing' },
      'dj1', null, null, nowISO
    );

    expect(response.status).toBe(404);
  });

  it('rejects cancellation by non-owner non-admin', async () => {
    mockGetDocument.mockResolvedValueOnce({
      djId: 'other_dj',
      status: 'scheduled',
    });
    mockIsAdmin.mockResolvedValueOnce(false);

    const response = await handleCancel(
      { slotId: 'slot1' },
      'dj1', null, null, nowISO
    );

    expect(response.status).toBe(403);
  });

  it('allows admin to cancel any slot', async () => {
    mockGetDocument.mockResolvedValueOnce({
      djId: 'other_dj',
      status: 'scheduled',
      streamKey: 'key',
    });
    mockIsAdmin.mockResolvedValueOnce(true);

    const response = await handleCancel(
      { slotId: 'slot1' },
      'admin1', null, null, nowISO
    );

    expect(response.status).toBe(200);
  });
});

// =============================================
// Slot update
// =============================================
describe('handleUpdateSlot', () => {
  it('updates slot title and genre', async () => {
    mockGetDocument.mockResolvedValueOnce({
      djId: 'dj1',
      djName: 'TestDJ',
      title: 'Old Title',
      genre: 'DnB',
      status: 'scheduled',
    });

    const response = await handleUpdateSlot(
      { slotId: 'slot1', title: 'New Title', genre: 'Jungle' },
      'dj1', null, null, {}, nowISO
    );

    expect(response.status).toBe(200);
    const body = await parseResponse(response);
    expect(body.message).toBe('Slot updated successfully');
  });

  it('rejects update on cancelled slot', async () => {
    mockGetDocument.mockResolvedValueOnce({
      djId: 'dj1',
      status: 'cancelled',
    });

    const response = await handleUpdateSlot(
      { slotId: 'slot1', title: 'New Title' },
      'dj1', null, null, {}, nowISO
    );

    expect(response.status).toBe(400);
    const body = await parseResponse(response);
    expect(body.error).toContain('Cannot update');
  });

  it('rejects missing slotId', async () => {
    const response = await handleUpdateSlot(
      { title: 'X' },
      'dj1', null, null, {}, nowISO
    );

    expect(response.status).toBe(400);
  });

  it('tracks DJ name change history', async () => {
    mockGetDocument.mockResolvedValueOnce({
      djId: 'dj1',
      djName: 'OldName',
      status: 'scheduled',
    });

    const response = await handleUpdateSlot(
      { slotId: 'slot1', djName: 'NewName' },
      'dj1', null, null, {}, nowISO
    );

    expect(response.status).toBe(200);
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'livestreamSlots', 'slot1',
      expect.objectContaining({
        djName: 'NewName',
        djHistory: expect.arrayContaining([
          expect.objectContaining({ djName: 'OldName', changedFrom: 'OldName' }),
        ]),
      }),
      null
    );
  });
});
