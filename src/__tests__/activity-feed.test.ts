import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logActivity, getGlobalFeed, getPersonalizedFeed, cleanupOldActivity } from '../lib/activity-feed';

// =============================================
// D1Database mock helpers
// =============================================

function createMockD1(overrides: {
  firstResult?: Record<string, unknown> | null;
  allResults?: Record<string, unknown>[];
  runMeta?: { changes: number };
} = {}) {
  const runResult = {
    results: [],
    success: true,
    meta: overrides.runMeta ?? { changes: 1 },
  };

  const allResult = {
    results: overrides.allResults ?? [],
    success: true,
  };

  const firstFn = vi.fn().mockResolvedValue(overrides.firstResult ?? null);
  const runFn = vi.fn().mockResolvedValue(runResult);
  const allFn = vi.fn().mockResolvedValue(allResult);

  const bindFn = vi.fn().mockReturnValue({
    first: firstFn,
    run: runFn,
    all: allFn,
    bind: vi.fn().mockReturnValue({
      first: firstFn,
      run: runFn,
      all: allFn,
    }),
  });

  const prepareFn = vi.fn().mockReturnValue({
    bind: bindFn,
  });

  return {
    db: { prepare: prepareFn } as unknown as D1Database,
    prepareFn,
    bindFn,
    runFn,
    firstFn,
    allFn,
  };
}

// =============================================
// logActivity
// =============================================
describe('logActivity', () => {
  it('returns an ID on successful insert', async () => {
    const { db } = createMockD1();
    const result = await logActivity(db, {
      eventType: 'new_release',
      actorId: 'user1',
      actorName: 'Test Artist',
      targetId: 'release1',
      targetType: 'release',
    });
    expect(result).toMatch(/^af_\d+_/);
  });

  it('returns null when dedup detects existing event', async () => {
    const { db } = createMockD1({ firstResult: { id: 'existing' } });
    const result = await logActivity(db, {
      eventType: 'like',
      actorId: 'user1',
      targetId: 'mix1',
    });
    expect(result).toBeNull();
  });

  it('skips dedup check when actorId or targetId is missing', async () => {
    const { db, prepareFn } = createMockD1();
    await logActivity(db, {
      eventType: 'new_release',
      // No actorId or targetId
    });
    // Only INSERT query should be called, not dedup SELECT
    const queries = prepareFn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(queries.every((q: string) => q.includes('INSERT'))).toBe(true);
  });

  it('serializes object metadata to JSON', async () => {
    const { db, bindFn } = createMockD1();
    await logActivity(db, {
      eventType: 'comment',
      metadata: { rating: 5, comment: 'Great!' },
    });
    // metadata is the 11th bind parameter (index 10)
    const bindArgs = bindFn.mock.calls[bindFn.mock.calls.length - 1];
    const metadataArg = bindArgs.find((a: unknown) => typeof a === 'string' && a.includes('rating'));
    expect(metadataArg).toContain('"rating":5');
  });

  it('returns null and does not throw on DB error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockRejectedValue(new Error('DB error')),
          run: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      }),
    } as unknown as D1Database;

    const result = await logActivity(db, {
      eventType: 'like',
      actorId: 'user1',
      targetId: 'mix1',
    });
    expect(result).toBeNull();
  });
});

// =============================================
// getGlobalFeed
// =============================================
describe('getGlobalFeed', () => {
  it('returns events and nextCursor', async () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      id: `af_${i}`,
      event_type: 'like',
      actor_id: null,
      actor_name: null,
      actor_avatar: null,
      target_id: `mix_${i}`,
      target_type: 'mix',
      target_name: `Mix ${i}`,
      target_image: null,
      target_url: null,
      metadata: null,
      created_at: `2026-01-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`,
    }));

    const { db } = createMockD1({ allResults: events });
    const result = await getGlobalFeed(db, { limit: 20 });
    expect(result.events).toHaveLength(20);
    expect(result.nextCursor).toBe(events[19].created_at);
  });

  it('returns null cursor when fewer results than limit', async () => {
    const events = [
      { id: 'af_1', event_type: 'like', created_at: '2026-01-01T00:00:00Z' },
    ];
    const { db } = createMockD1({ allResults: events as Record<string, unknown>[] });
    const result = await getGlobalFeed(db, { limit: 20 });
    expect(result.nextCursor).toBeNull();
  });

  it('clamps limit to 50 max', async () => {
    const { db, bindFn } = createMockD1({ allResults: [] });
    await getGlobalFeed(db, { limit: 100 });
    const lastBind = bindFn.mock.calls[0];
    expect(lastBind[lastBind.length - 1]).toBe(50);
  });

  it('returns empty array on error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error('fail')),
        }),
      }),
    } as unknown as D1Database;

    const result = await getGlobalFeed(db);
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// =============================================
// getPersonalizedFeed
// =============================================
describe('getPersonalizedFeed', () => {
  it('builds query with followed artists, userId, and high-value events', async () => {
    const { db, prepareFn } = createMockD1({ allResults: [] });
    await getPersonalizedFeed(db, 'user1', ['artist1', 'artist2']);
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('actor_id IN');
    expect(query).toContain('target_id = ?');
    expect(query).toContain('event_type IN');
  });

  it('works with empty followed artists list', async () => {
    const { db, prepareFn } = createMockD1({ allResults: [] });
    await getPersonalizedFeed(db, 'user1', []);
    const query = prepareFn.mock.calls[0][0] as string;
    // Should NOT contain actor_id IN when no followed artists
    expect(query).not.toContain('actor_id IN');
    // Should still have target_id and event_type conditions
    expect(query).toContain('target_id = ?');
    expect(query).toContain('event_type IN');
  });
});

// =============================================
// cleanupOldActivity
// =============================================
describe('cleanupOldActivity', () => {
  it('deletes events older than retention period', async () => {
    const { db, prepareFn, runFn } = createMockD1({ runMeta: { changes: 42 } });
    const result = await cleanupOldActivity(db, 30);
    expect(result.deleted).toBe(42);
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('DELETE');
    expect(query).toContain('activity_feed');
  });

  it('defaults to 90 days retention', async () => {
    const { db, bindFn } = createMockD1({ runMeta: { changes: 0 } });
    await cleanupOldActivity(db);
    // The bind argument should be an ISO date roughly 90 days ago
    const cutoff = bindFn.mock.calls[0][0] as string;
    const daysAgo = (Date.now() - new Date(cutoff).getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeCloseTo(90, 0);
  });

  it('returns deleted: 0 on error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('fail')),
        }),
      }),
    } as unknown as D1Database;

    const result = await cleanupOldActivity(db);
    expect(result.deleted).toBe(0);
  });
});
