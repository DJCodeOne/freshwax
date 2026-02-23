import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireCronLock, releaseCronLock } from '../lib/cron-lock';

// =============================================
// D1Database mock helpers
// =============================================
function createMockD1(overrides: {
  firstResult?: Record<string, unknown> | null;
  runMeta?: { changes: number };
} = {}) {
  const runResult = {
    results: [],
    success: true,
    meta: overrides.runMeta ?? { changes: 1 },
  };

  const firstFn = vi.fn().mockResolvedValue(overrides.firstResult ?? null);
  const runFn = vi.fn().mockResolvedValue(runResult);

  const bindFn = vi.fn().mockReturnValue({
    first: firstFn,
    run: runFn,
    bind: vi.fn().mockReturnValue({
      first: firstFn,
      run: runFn,
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
  };
}

// =============================================
// acquireCronLock
// =============================================
describe('acquireCronLock', () => {
  it('returns true when no existing lock (row inserted)', async () => {
    const { db } = createMockD1({ runMeta: { changes: 1 } });
    const result = await acquireCronLock(db, 'test-job');
    expect(result).toBe(true);
  });

  it('returns false when lock exists and not expired (no row inserted)', async () => {
    const { db } = createMockD1({ runMeta: { changes: 0 } });
    const result = await acquireCronLock(db, 'test-job');
    expect(result).toBe(false);
  });

  it('calls prepare twice — once for DELETE expired, once for INSERT', async () => {
    const { db, prepareFn } = createMockD1();
    await acquireCronLock(db, 'test-job');
    expect(prepareFn).toHaveBeenCalledTimes(2);
  });

  it('passes the job name to both queries via bind', async () => {
    const { db, bindFn } = createMockD1();
    await acquireCronLock(db, 'my-cron-job');
    // First call: DELETE bind(jobName, now.toISOString())
    expect(bindFn.mock.calls[0][0]).toBe('my-cron-job');
    // Second call: INSERT bind(jobName, now, expiresAt)
    expect(bindFn.mock.calls[1][0]).toBe('my-cron-job');
  });

  it('deletes expired locks before attempting insert', async () => {
    const { db, prepareFn } = createMockD1();
    await acquireCronLock(db, 'cleanup-job');
    const firstQuery = prepareFn.mock.calls[0][0] as string;
    expect(firstQuery).toContain('DELETE');
    expect(firstQuery).toContain('expires_at');
  });

  it('uses INSERT OR IGNORE for the lock insertion', async () => {
    const { db, prepareFn } = createMockD1();
    await acquireCronLock(db, 'insert-job');
    const secondQuery = prepareFn.mock.calls[1][0] as string;
    expect(secondQuery).toContain('INSERT OR IGNORE');
    expect(secondQuery).toContain('cron_locks');
  });
});

// =============================================
// releaseCronLock
// =============================================
describe('releaseCronLock', () => {
  it('deletes the lock row for the given job', async () => {
    const { db, prepareFn, bindFn, runFn } = createMockD1();
    await releaseCronLock(db, 'test-job');
    expect(prepareFn).toHaveBeenCalledTimes(1);
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('DELETE');
    expect(query).toContain('cron_locks');
    expect(bindFn).toHaveBeenCalledWith('test-job');
    expect(runFn).toHaveBeenCalled();
  });

  it('does not throw on success', async () => {
    const { db } = createMockD1();
    await expect(releaseCronLock(db, 'safe-job')).resolves.toBeUndefined();
  });
});
