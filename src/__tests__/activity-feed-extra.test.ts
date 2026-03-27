import { describe, it, expect, vi } from 'vitest';
import { logActivity, getGlobalFeed, getPersonalizedFeed, cleanupOldActivity } from '../lib/activity-feed';
import type { ActivityFeedRow } from '../lib/activity-feed';

// =============================================
// D1Database mock helper (same pattern as existing tests)
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
// logActivity — additional coverage
// =============================================
describe('logActivity — extra', () => {
  it('passes string metadata through unchanged', async () => {
    const { db, bindFn } = createMockD1();
    await logActivity(db, {
      eventType: 'comment',
      metadata: 'plain string metadata',
    });
    const bindArgs = bindFn.mock.calls[bindFn.mock.calls.length - 1];
    expect(bindArgs).toContain('plain string metadata');
  });

  it('sets metadata to null when not provided', async () => {
    const { db, bindFn } = createMockD1();
    await logActivity(db, {
      eventType: 'new_release',
      actorId: 'user1',
    });
    // metadata is 11th bind param (index 10 in the INSERT call)
    const insertBindArgs = bindFn.mock.calls[bindFn.mock.calls.length - 1];
    // Find the null that comes after target_url and before the ISO date
    const nullCount = insertBindArgs.filter((a: unknown) => a === null).length;
    expect(nullCount).toBeGreaterThan(0);
  });

  it('generates unique IDs for consecutive events', async () => {
    const { db } = createMockD1();
    const id1 = await logActivity(db, {
      eventType: 'like',
      actorId: 'a',
      targetId: 't1',
    });
    const id2 = await logActivity(db, {
      eventType: 'like',
      actorId: 'a',
      targetId: 't2',
    });
    expect(id1).not.toBe(id2);
  });

  it('handles all optional fields being undefined', async () => {
    const { db } = createMockD1();
    const result = await logActivity(db, {
      eventType: 'dj_went_live',
    });
    expect(result).toMatch(/^af_\d+_/);
  });

  it('fills all actor and target fields when provided', async () => {
    const { db, bindFn } = createMockD1();
    await logActivity(db, {
      eventType: 'new_mix',
      actorId: 'dj1',
      actorName: 'DJ Test',
      actorAvatar: 'https://example.com/avatar.jpg',
      targetId: 'mix1',
      targetType: 'mix',
      targetName: 'Test Mix',
      targetImage: 'https://example.com/mix.jpg',
      targetUrl: '/dj-mix/mix1',
    });
    const lastBindArgs = bindFn.mock.calls[bindFn.mock.calls.length - 1];
    expect(lastBindArgs).toContain('dj1');
    expect(lastBindArgs).toContain('DJ Test');
    expect(lastBindArgs).toContain('https://example.com/avatar.jpg');
    expect(lastBindArgs).toContain('mix1');
    expect(lastBindArgs).toContain('mix');
    expect(lastBindArgs).toContain('Test Mix');
    expect(lastBindArgs).toContain('https://example.com/mix.jpg');
    expect(lastBindArgs).toContain('/dj-mix/mix1');
  });
});

// =============================================
// getGlobalFeed — additional coverage
// =============================================
describe('getGlobalFeed — extra', () => {
  it('clamps limit to minimum of 1', async () => {
    const { db, bindFn } = createMockD1({ allResults: [] });
    await getGlobalFeed(db, { limit: 0 });
    const lastBind = bindFn.mock.calls[0];
    expect(lastBind[lastBind.length - 1]).toBe(1);
  });

  it('clamps negative limit to 1', async () => {
    const { db, bindFn } = createMockD1({ allResults: [] });
    await getGlobalFeed(db, { limit: -5 });
    const lastBind = bindFn.mock.calls[0];
    expect(lastBind[lastBind.length - 1]).toBe(1);
  });

  it('defaults limit to 20 when not specified', async () => {
    const { db, bindFn } = createMockD1({ allResults: [] });
    await getGlobalFeed(db);
    const lastBind = bindFn.mock.calls[0];
    expect(lastBind[lastBind.length - 1]).toBe(20);
  });

  it('includes before cursor in query when provided', async () => {
    const { db, prepareFn, bindFn } = createMockD1({ allResults: [] });
    await getGlobalFeed(db, { before: '2026-01-15T00:00:00Z' });
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('created_at < ?');
    expect(bindFn.mock.calls[0]).toContain('2026-01-15T00:00:00Z');
  });
});

// =============================================
// getPersonalizedFeed — additional coverage
// =============================================
describe('getPersonalizedFeed — extra', () => {
  it('includes cursor clause when before option is provided', async () => {
    const { db, prepareFn } = createMockD1({ allResults: [] });
    await getPersonalizedFeed(db, 'user1', ['artist1'], {
      before: '2026-01-10T00:00:00Z',
    });
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('created_at < ?');
  });

  it('clamps limit to max 50', async () => {
    const { db, bindFn } = createMockD1({ allResults: [] });
    await getPersonalizedFeed(db, 'user1', [], { limit: 200 });
    const lastBind = bindFn.mock.calls[0];
    expect(lastBind[lastBind.length - 1]).toBe(50);
  });

  it('returns nextCursor when results equal limit', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: `af_${i}`,
      event_type: 'like',
      actor_id: 'artist1',
      actor_name: null,
      actor_avatar: null,
      target_id: null,
      target_type: null,
      target_name: null,
      target_image: null,
      target_url: null,
      metadata: null,
      created_at: `2026-01-${String(10 - i).padStart(2, '0')}T00:00:00.000Z`,
    }));

    const { db } = createMockD1({ allResults: events });
    const result = await getPersonalizedFeed(db, 'user1', ['artist1'], { limit: 5 });
    expect(result.nextCursor).toBe(events[4].created_at);
  });

  it('returns null nextCursor when results are fewer than limit', async () => {
    const events = [
      {
        id: 'af_1', event_type: 'new_release', actor_id: 'a1',
        actor_name: null, actor_avatar: null, target_id: null,
        target_type: null, target_name: null, target_image: null,
        target_url: null, metadata: null, created_at: '2026-01-01T00:00:00Z',
      },
    ];

    const { db } = createMockD1({ allResults: events as Record<string, unknown>[] });
    const result = await getPersonalizedFeed(db, 'user1', [], { limit: 20 });
    expect(result.nextCursor).toBeNull();
  });

  it('returns empty events on DB error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error('DB connection lost')),
        }),
      }),
    } as unknown as D1Database;

    const result = await getPersonalizedFeed(db, 'user1', ['a1']);
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// =============================================
// cleanupOldActivity — additional coverage
// =============================================
describe('cleanupOldActivity — extra', () => {
  it('uses correct cutoff for custom retention days', async () => {
    const { db, bindFn } = createMockD1({ runMeta: { changes: 5 } });
    await cleanupOldActivity(db, 7);
    const cutoff = bindFn.mock.calls[0][0] as string;
    const daysAgo = (Date.now() - new Date(cutoff).getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeCloseTo(7, 0);
  });

  it('returns deleted count from meta.changes', async () => {
    const { db } = createMockD1({ runMeta: { changes: 123 } });
    const result = await cleanupOldActivity(db, 30);
    expect(result.deleted).toBe(123);
  });
});
