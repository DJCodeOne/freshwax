import { describe, it, expect, vi } from 'vitest';
import { addDjSupport, removeDjSupport, getSupportersForRelease, getSupportsForMix, scanTracklistForSupport } from '../lib/dj-support';

// =============================================
// D1Database mock helpers
// =============================================

function createMockD1(overrides: {
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

  const runFn = vi.fn().mockResolvedValue(runResult);
  const allFn = vi.fn().mockResolvedValue(allResult);

  const bindFn = vi.fn().mockReturnValue({
    run: runFn,
    all: allFn,
    bind: vi.fn().mockReturnValue({
      run: runFn,
      all: allFn,
    }),
  });

  const prepareFn = vi.fn().mockReturnValue({
    bind: bindFn,
    all: allFn,
  });

  return {
    db: { prepare: prepareFn } as unknown as D1Database,
    prepareFn,
    bindFn,
    runFn,
    allFn,
  };
}

// =============================================
// addDjSupport
// =============================================
describe('addDjSupport', () => {
  it('returns true when row inserted', async () => {
    const { db } = createMockD1({ runMeta: { changes: 1 } });
    const result = await addDjSupport(db, {
      mixId: 'mix1',
      releaseId: 'rel1',
      djName: 'DJ Test',
      releaseTitle: 'Track One',
      artistName: 'Artist A',
      source: 'manual',
    });
    expect(result).toBe(true);
  });

  it('returns false when duplicate (INSERT OR IGNORE, changes=0)', async () => {
    const { db } = createMockD1({ runMeta: { changes: 0 } });
    const result = await addDjSupport(db, {
      mixId: 'mix1',
      releaseId: 'rel1',
      djName: 'DJ Test',
      releaseTitle: 'Track One',
      artistName: 'Artist A',
      source: 'manual',
    });
    expect(result).toBe(false);
  });

  it('generates composite ID from mixId and releaseId', async () => {
    const { db, bindFn } = createMockD1();
    await addDjSupport(db, {
      mixId: 'abc',
      releaseId: 'xyz',
      djName: 'DJ',
      releaseTitle: 'T',
      artistName: 'A',
      source: 'manual',
    });
    // First bind argument should be the composite ID
    expect(bindFn.mock.calls[0][0]).toBe('abc_xyz');
  });

  it('uses INSERT OR IGNORE SQL', async () => {
    const { db, prepareFn } = createMockD1();
    await addDjSupport(db, {
      mixId: 'a',
      releaseId: 'b',
      djName: 'DJ',
      releaseTitle: 'T',
      artistName: 'A',
      source: 'tracklist_scan',
      confidence: 0.8,
    });
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('INSERT OR IGNORE');
    expect(query).toContain('dj_support');
  });

  it('returns false on DB error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('fail')),
        }),
      }),
    } as unknown as D1Database;

    const result = await addDjSupport(db, {
      mixId: 'a',
      releaseId: 'b',
      djName: 'DJ',
      releaseTitle: 'T',
      artistName: 'A',
      source: 'manual',
    });
    expect(result).toBe(false);
  });
});

// =============================================
// removeDjSupport
// =============================================
describe('removeDjSupport', () => {
  it('returns true when manual entry deleted', async () => {
    const { db } = createMockD1({ runMeta: { changes: 1 } });
    const result = await removeDjSupport(db, 'mix1', 'rel1');
    expect(result).toBe(true);
  });

  it('returns false when no row deleted', async () => {
    const { db } = createMockD1({ runMeta: { changes: 0 } });
    const result = await removeDjSupport(db, 'mix1', 'rel1');
    expect(result).toBe(false);
  });

  it('only deletes manual entries (source = manual)', async () => {
    const { db, prepareFn } = createMockD1();
    await removeDjSupport(db, 'mix1', 'rel1');
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain("source = 'manual'");
  });
});

// =============================================
// getSupportersForRelease
// =============================================
describe('getSupportersForRelease', () => {
  it('returns mapped rows for a release', async () => {
    const rows = [
      {
        id: 'mix1_rel1',
        mix_id: 'mix1',
        release_id: 'rel1',
        dj_user_id: 'u1',
        dj_name: 'DJ Alpha',
        release_title: 'Track One',
        artist_name: 'Artist A',
        source: 'manual',
        confidence: 1.0,
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    const { db } = createMockD1({ allResults: rows });
    const result = await getSupportersForRelease(db, 'rel1');
    expect(result).toHaveLength(1);
    expect(result[0].djName).toBe('DJ Alpha');
    expect(result[0].mixId).toBe('mix1');
  });

  it('returns empty array on error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error('fail')),
        }),
      }),
    } as unknown as D1Database;

    const result = await getSupportersForRelease(db, 'rel1');
    expect(result).toEqual([]);
  });
});

// =============================================
// getSupportsForMix
// =============================================
describe('getSupportsForMix', () => {
  it('queries by mix_id and orders by confidence DESC', async () => {
    const { db, prepareFn } = createMockD1({ allResults: [] });
    await getSupportsForMix(db, 'mix1');
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('mix_id');
    expect(query).toContain('confidence DESC');
  });
});

// =============================================
// scanTracklistForSupport
// =============================================
describe('scanTracklistForSupport', () => {
  it('returns matched=0 when no releases exist', async () => {
    const { db } = createMockD1({ allResults: [] });
    const result = await scanTracklistForSupport(db, 'mix1', 'u1', 'DJ Test', [
      'Artist - Track Name',
    ]);
    expect(result.matched).toBe(0);
    expect(result.total).toBe(1);
  });

  it('matches exact artist + title (confidence 1.0)', async () => {
    // Mock: first call returns releases, subsequent calls for INSERT
    const releases = [
      { id: 'rel1', title: 'Jungle Fever', artist_name: 'Congo Natty' },
    ];

    const runFn = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const allFn = vi.fn().mockResolvedValue({ results: releases });

    const db = {
      prepare: vi.fn().mockReturnValue({
        all: allFn,
        bind: vi.fn().mockReturnValue({
          run: runFn,
          all: allFn,
        }),
      }),
    } as unknown as D1Database;

    const result = await scanTracklistForSupport(db, 'mix1', 'u1', 'DJ Test', [
      'Congo Natty - Jungle Fever',
    ]);
    expect(result.matched).toBe(1);
  });

  it('skips lines without " - " separator', async () => {
    const releases = [
      { id: 'rel1', title: 'Track', artist_name: 'Artist' },
    ];

    const allFn = vi.fn().mockResolvedValue({ results: releases });
    const db = {
      prepare: vi.fn().mockReturnValue({
        all: allFn,
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
          all: allFn,
        }),
      }),
    } as unknown as D1Database;

    const result = await scanTracklistForSupport(db, 'mix1', 'u1', 'DJ Test', [
      'No separator here',
      'Another track without dash',
    ]);
    expect(result.matched).toBe(0);
  });

  it('returns matched=0 on DB error', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error('DB fail')),
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error('DB fail')),
        }),
      }),
    } as unknown as D1Database;

    const result = await scanTracklistForSupport(db, 'mix1', 'u1', 'DJ Test', [
      'Artist - Track',
    ]);
    expect(result.matched).toBe(0);
  });
});
