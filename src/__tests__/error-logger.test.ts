import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock error-alerting before importing error-logger
vi.mock('../lib/error-alerting', () => ({
  checkAndAlertErrorSpike: vi.fn().mockResolvedValue(false),
}));

import { logError, logServerError, cleanupErrorLogs } from '../lib/error-logger';
import { checkAndAlertErrorSpike } from '../lib/error-alerting';

// =============================================
// D1Database mock helpers
// =============================================
function createMockD1(overrides: {
  runResult?: { meta?: { changes?: number } };
  runError?: Error;
} = {}) {
  const runFn = overrides.runError
    ? vi.fn().mockRejectedValue(overrides.runError)
    : vi.fn().mockResolvedValue(overrides.runResult ?? { meta: { changes: 1 } });

  const bindFn = vi.fn().mockReturnValue({ run: runFn });

  const prepareFn = vi.fn().mockReturnValue({ bind: bindFn });

  return {
    db: { prepare: prepareFn } as unknown as import('@cloudflare/workers-types').D1Database,
    prepareFn,
    bindFn,
    runFn,
  };
}

// =============================================
// fingerprint (tested indirectly through logError)
// =============================================
describe('error fingerprinting', () => {
  it('generates consistent fingerprint for same message', async () => {
    const { db, bindFn } = createMockD1();

    await logError({ source: 'server', message: 'Test error' }, { DB: db } as never);
    const fp1 = bindFn.mock.calls[0][11]; // fingerprint is 12th param

    // Reset and log again with same message
    bindFn.mockClear();
    await logError({ source: 'server', message: 'Test error' }, { DB: db } as never);
    const fp2 = bindFn.mock.calls[0][11];

    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
    expect(fp1.length).toBeGreaterThan(0);
  });

  it('generates different fingerprint for different messages', async () => {
    const { db, bindFn } = createMockD1();

    await logError({ source: 'server', message: 'Error A' }, { DB: db } as never);
    const fp1 = bindFn.mock.calls[0][11];

    bindFn.mockClear();
    await logError({ source: 'server', message: 'Error B' }, { DB: db } as never);
    const fp2 = bindFn.mock.calls[0][11];

    expect(fp1).not.toBe(fp2);
  });

  it('includes first line of stack trace in fingerprint', async () => {
    const { db, bindFn } = createMockD1();

    await logError(
      { source: 'server', message: 'Same msg', stack: 'at foo.js:1:1\nat bar.js:2:2' },
      { DB: db } as never
    );
    const fp1 = bindFn.mock.calls[0][11];

    bindFn.mockClear();
    await logError(
      { source: 'server', message: 'Same msg', stack: 'at different.js:99:99\nat bar.js:2:2' },
      { DB: db } as never
    );
    const fp2 = bindFn.mock.calls[0][11];

    expect(fp1).not.toBe(fp2);
  });
});

// =============================================
// logError
// =============================================
describe('logError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when env is undefined', async () => {
    await expect(logError({ source: 'client', message: 'test' }, undefined)).resolves.toBeUndefined();
  });

  it('does nothing when DB is not present', async () => {
    await expect(logError({ source: 'client', message: 'test' }, {} as never)).resolves.toBeUndefined();
  });

  it('inserts error into D1 error_logs table', async () => {
    const { db, prepareFn, bindFn, runFn } = createMockD1();

    await logError({
      source: 'server',
      level: 'error',
      message: 'Something broke',
      stack: 'Error: Something broke\n  at handler (/api/test.ts:10:5)',
      url: 'https://freshwax.co.uk/api/test',
      endpoint: '/api/test',
      statusCode: 500,
      userAgent: 'Mozilla/5.0',
      ip: '1.2.3.4',
      userId: 'user-123',
      metadata: { extra: 'info' },
    }, { DB: db } as never);

    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('INSERT INTO error_logs');
    expect(bindFn).toHaveBeenCalledWith(
      'server',
      'error',
      'Something broke',
      'Error: Something broke\n  at handler (/api/test.ts:10:5)',
      'https://freshwax.co.uk/api/test',
      '/api/test',
      500,
      'Mozilla/5.0',
      '1.2.3.4',
      'user-123',
      JSON.stringify({ extra: 'info' }),
      expect.any(String) // fingerprint
    );
    expect(runFn).toHaveBeenCalled();
  });

  it('defaults level to "error" when not provided', async () => {
    const { db, bindFn } = createMockD1();

    await logError({ source: 'client', message: 'msg' }, { DB: db } as never);
    expect(bindFn.mock.calls[0][1]).toBe('error');
  });

  it('truncates message to 2000 chars', async () => {
    const { db, bindFn } = createMockD1();
    const longMessage = 'x'.repeat(5000);

    await logError({ source: 'server', message: longMessage }, { DB: db } as never);
    const storedMessage = bindFn.mock.calls[0][2] as string;
    expect(storedMessage.length).toBe(2000);
  });

  it('truncates stack to 5000 chars', async () => {
    const { db, bindFn } = createMockD1();
    const longStack = 'at line\n'.repeat(1000);

    await logError({ source: 'server', message: 'err', stack: longStack }, { DB: db } as never);
    const storedStack = bindFn.mock.calls[0][3] as string;
    expect(storedStack.length).toBeLessThanOrEqual(5000);
  });

  it('passes null for missing optional fields', async () => {
    const { db, bindFn } = createMockD1();

    await logError({ source: 'client', message: 'minimal' }, { DB: db } as never);
    // stack, url, endpoint, statusCode, userAgent, ip, userId, metadata
    expect(bindFn.mock.calls[0][3]).toBeNull(); // stack
    expect(bindFn.mock.calls[0][4]).toBeNull(); // url
    expect(bindFn.mock.calls[0][5]).toBeNull(); // endpoint
    expect(bindFn.mock.calls[0][6]).toBeNull(); // statusCode
    expect(bindFn.mock.calls[0][7]).toBeNull(); // userAgent
    expect(bindFn.mock.calls[0][8]).toBeNull(); // ip
    expect(bindFn.mock.calls[0][9]).toBeNull(); // userId
    expect(bindFn.mock.calls[0][10]).toBeNull(); // metadata
  });

  it('does not throw when D1 insert fails', async () => {
    const { db } = createMockD1({ runError: new Error('D1 write failed') });

    await expect(
      logError({ source: 'server', message: 'test' }, { DB: db } as never)
    ).resolves.toBeUndefined();
  });

  it('calls checkAndAlertErrorSpike after logging', async () => {
    const { db } = createMockD1();

    await logError({ source: 'server', message: 'test' }, { DB: db } as never);

    expect(checkAndAlertErrorSpike).toHaveBeenCalled();
  });
});

// =============================================
// logServerError
// =============================================
describe('logServerError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts message and stack from Error objects', async () => {
    const { db, bindFn } = createMockD1();
    const error = new Error('Server crash');

    const request = new Request('https://freshwax.co.uk/api/orders', {
      headers: {
        'User-Agent': 'TestAgent/1.0',
        'CF-Connecting-IP': '10.0.0.1',
      },
    });

    await logServerError(error, request, { DB: db } as never);

    expect(bindFn.mock.calls[0][0]).toBe('server');   // source
    expect(bindFn.mock.calls[0][1]).toBe('error');     // level
    expect(bindFn.mock.calls[0][2]).toBe('Server crash'); // message
    expect(bindFn.mock.calls[0][3]).toContain('Error: Server crash'); // stack
  });

  it('handles non-Error thrown values', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/test');

    await logServerError('string error', request, { DB: db } as never);
    expect(bindFn.mock.calls[0][2]).toBe('string error');
    expect(bindFn.mock.calls[0][3]).toBeNull(); // no stack for string errors
  });

  it('extracts IP from CF-Connecting-IP header', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/test', {
      headers: { 'CF-Connecting-IP': '203.0.113.50' },
    });

    await logServerError(new Error('err'), request, { DB: db } as never);
    expect(bindFn.mock.calls[0][8]).toBe('203.0.113.50');
  });

  it('falls back to X-Forwarded-For when CF-Connecting-IP missing', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/test', {
      headers: { 'X-Forwarded-For': '192.168.1.1, 10.0.0.1' },
    });

    await logServerError(new Error('err'), request, { DB: db } as never);
    expect(bindFn.mock.calls[0][8]).toBe('192.168.1.1');
  });

  it('extracts endpoint from request URL pathname', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/orders/create');

    await logServerError(new Error('err'), request, { DB: db } as never);
    expect(bindFn.mock.calls[0][5]).toBe('/api/orders/create');
  });

  it('uses extra.endpoint over URL pathname when provided', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/orders/create');

    await logServerError(new Error('err'), request, { DB: db } as never, {
      endpoint: '/api/custom-endpoint',
    });
    expect(bindFn.mock.calls[0][5]).toBe('/api/custom-endpoint');
  });

  it('uses extra.statusCode when provided', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/test');

    await logServerError(new Error('err'), request, { DB: db } as never, {
      statusCode: 403,
    });
    expect(bindFn.mock.calls[0][6]).toBe(403);
  });

  it('defaults statusCode to 500', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/test');

    await logServerError(new Error('err'), request, { DB: db } as never);
    expect(bindFn.mock.calls[0][6]).toBe(500);
  });

  it('passes userId from extra', async () => {
    const { db, bindFn } = createMockD1();
    const request = new Request('https://freshwax.co.uk/api/test');

    await logServerError(new Error('err'), request, { DB: db } as never, {
      userId: 'user-abc',
    });
    expect(bindFn.mock.calls[0][9]).toBe('user-abc');
  });
});

// =============================================
// cleanupErrorLogs
// =============================================
describe('cleanupErrorLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when env is undefined', async () => {
    const result = await cleanupErrorLogs(undefined);
    expect(result).toBe(0);
  });

  it('returns 0 when DB is not present', async () => {
    const result = await cleanupErrorLogs({} as never);
    expect(result).toBe(0);
  });

  it('deletes error logs older than 30 days by default', async () => {
    const { db, prepareFn, bindFn } = createMockD1({ runResult: { meta: { changes: 42 } } });

    const beforeCall = Date.now();
    const result = await cleanupErrorLogs({ DB: db } as never);
    const afterCall = Date.now();

    expect(result).toBe(42);
    const query = prepareFn.mock.calls[0][0] as string;
    expect(query).toContain('DELETE FROM error_logs');
    expect(query).toContain('created_at');

    // Verify the cutoff date is roughly 30 days ago
    const cutoffArg = bindFn.mock.calls[0][0] as string;
    const cutoffDate = new Date(cutoffArg).getTime();
    const expectedCutoff30d = 30 * 24 * 60 * 60 * 1000;
    expect(cutoffDate).toBeGreaterThanOrEqual(beforeCall - expectedCutoff30d - 1000);
    expect(cutoffDate).toBeLessThanOrEqual(afterCall - expectedCutoff30d + 1000);
  });

  it('accepts custom daysToKeep parameter', async () => {
    const { db, bindFn } = createMockD1({ runResult: { meta: { changes: 5 } } });

    const beforeCall = Date.now();
    const result = await cleanupErrorLogs({ DB: db } as never, 7);

    expect(result).toBe(5);
    const cutoffArg = bindFn.mock.calls[0][0] as string;
    const cutoffDate = new Date(cutoffArg).getTime();
    const expected7d = 7 * 24 * 60 * 60 * 1000;
    expect(cutoffDate).toBeGreaterThanOrEqual(beforeCall - expected7d - 1000);
  });

  it('returns 0 when D1 query fails', async () => {
    const { db } = createMockD1({ runError: new Error('D1 failure') });

    const result = await cleanupErrorLogs({ DB: db } as never);
    expect(result).toBe(0);
  });

  it('returns 0 when meta.changes is undefined', async () => {
    const { db } = createMockD1({ runResult: { meta: undefined as never } });

    const result = await cleanupErrorLogs({ DB: db } as never);
    expect(result).toBe(0);
  });
});
