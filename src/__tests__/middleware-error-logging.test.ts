// The 5xx logging path in src/middleware.ts, exercised against a fake D1 so the
// real logServerError -> logError -> INSERT path runs end to end.
//
// Endpoints catch their own errors and return ApiErrors.serverError(), which
// puts the cause in the JSON body and leaves statusText empty. Logging
// statusText alone recorded every failure across all 321 routes as the same
// "500 Server Error" string with a null stack -- identical message AND
// identical fingerprint -- so /admin/errors could not tell a Stripe failure
// from a Firestore one.
import { describe, it, expect, beforeEach } from 'vitest';
import { logServerError } from '../lib/error-logger';

// error_logs column order in the INSERT.
const COL = {
  source: 0, level: 1, message: 2, stack: 3, url: 4, endpoint: 5,
  statusCode: 6, userAgent: 7, ip: 8, userId: 9, metadata: 10, fingerprint: 11,
} as const;

let rows: unknown[][] = [];

/** Minimal D1 stand-in that records what the INSERT binds. */
const fakeEnv = () => ({
  DB: {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes('INSERT INTO error_logs')) rows.push(args);
          return { run: async () => ({}), first: async () => ({ count: 0 }), all: async () => ({ results: [] }) };
        },
        run: async () => ({}),
        first: async () => ({ count: 0 }),
        all: async () => ({ results: [] }),
      };
    },
  },
});

/** The middleware's 5xx branch. Mirrors src/middleware.ts. */
async function logFiveHundred(response: Response, request: Request, env: unknown) {
  const clone = response.clone();
  let detail = response.statusText || 'Server Error';
  try {
    const parsed = JSON.parse(await clone.text());
    if (parsed?.error) detail = String(parsed.error);
  } catch { /* non-JSON body */ }
  await logServerError(new Error(`${response.status} ${detail}`), request, env as never, {
    endpoint: new URL(request.url).pathname,
    statusCode: response.status,
  });
}

/** What the code did BEFORE this fix, for comparison. */
async function logFiveHundredOldWay(response: Response, request: Request, env: unknown) {
  await logServerError(
    new Error(`${response.status} ${response.statusText || 'Server Error'}`),
    request, env as never,
    { endpoint: new URL(request.url).pathname, statusCode: response.status }
  );
}

const req = (path = '/api/stripe/create-checkout-session/') =>
  new Request(`https://freshwax.co.uk${path}`);
const jsonErr = (error: string, status = 500) =>
  new Response(JSON.stringify({ success: false, error }), {
    status, headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => { rows = []; });

describe('5xx logging recovers the real cause', () => {
  it('writes the message from the JSON body, not "Server Error"', async () => {
    await logFiveHundred(jsonErr('Failed to create checkout session'), req(), fakeEnv());

    expect(rows).toHaveLength(1);
    expect(rows[0][COL.message]).toContain('Failed to create checkout session');
    expect(rows[0][COL.message]).not.toBe('500 Server Error');
  });

  it('records endpoint, status and source', async () => {
    await logFiveHundred(jsonErr('boom', 503), req('/api/pro/dashboard-data'), fakeEnv());

    expect(rows[0][COL.endpoint]).toBe('/api/pro/dashboard-data');
    expect(rows[0][COL.statusCode]).toBe(503);
    expect(rows[0][COL.source]).toBe('server');
  });

  // The core regression: two different failures must not collapse into one
  // fingerprint, or the error page groups unrelated outages together.
  it('gives distinct failures distinct fingerprints', async () => {
    await logFiveHundred(jsonErr('Stripe unavailable'), req('/api/stripe/create-checkout-session/'), fakeEnv());
    await logFiveHundred(jsonErr('Failed to update user role'), req('/api/admin/update-user-role'), fakeEnv());

    expect(rows[0][COL.message]).not.toBe(rows[1][COL.message]);
    expect(rows[0][COL.fingerprint]).not.toBe(rows[1][COL.fingerprint]);
  });

  it('the old behaviour collapsed them — proving the fix matters', async () => {
    await logFiveHundredOldWay(jsonErr('Stripe unavailable'), req('/api/stripe/create-checkout-session/'), fakeEnv());
    await logFiveHundredOldWay(jsonErr('Failed to update user role'), req('/api/admin/update-user-role'), fakeEnv());

    expect(rows[0][COL.message]).toBe(rows[1][COL.message]);       // both "500 Server Error"
    expect(rows[0][COL.fingerprint]).toBe(rows[1][COL.fingerprint]); // same bucket
  });

  it('falls back to status text for a non-JSON body', async () => {
    await logFiveHundred(new Response('<html>502 Bad Gateway</html>', { status: 502 }), req(), fakeEnv());
    expect(String(rows[0][COL.message])).toContain('502');
  });

  it('falls back cleanly for JSON with no error field', async () => {
    const odd = new Response(JSON.stringify({ ok: false }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
    await logFiveHundred(odd, req(), fakeEnv());
    expect(String(rows[0][COL.message])).toContain('500');
  });

  // Reading the body to log it must not consume the response we hand back.
  it('leaves the original response body readable', async () => {
    const response = jsonErr('Failed to create checkout session');
    await logFiveHundred(response, req(), fakeEnv());

    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe('Failed to create checkout session');
  });

  it('is a no-op without a DB binding rather than throwing', async () => {
    await expect(logFiveHundred(jsonErr('x'), req(), {})).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
  });
});

describe('keepAlive', () => {
  // Inline copy of the helper in src/middleware.ts.
  async function keepAlive(
    locals: { runtime?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } } },
    task: Promise<unknown>
  ): Promise<void> {
    const safe = task.catch(() => {});
    const ctx = locals?.runtime?.ctx;
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(safe);
    else await safe;
  }

  it('hands the task to waitUntil when available', async () => {
    const calls: Promise<unknown>[] = [];
    await keepAlive({ runtime: { ctx: { waitUntil: (p) => calls.push(p) } } }, Promise.resolve('x'));
    expect(calls).toHaveLength(1);
  });

  it('awaits the task when waitUntil is absent', async () => {
    let done = false;
    await keepAlive({}, (async () => { await Promise.resolve(); done = true; })());
    expect(done).toBe(true); // completed before returning, not left dangling
  });

  it('never throws when the task rejects', async () => {
    await expect(keepAlive({}, Promise.reject(new Error('D1 down')))).resolves.toBeUndefined();
  });
});
