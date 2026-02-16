import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock api-utils to intercept fetchWithTimeout
vi.mock('../lib/api-utils', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { sendResendEmail, logEmailToD1 } from '../lib/email';
import type { ResendEmailOptions } from '../lib/email';
import { fetchWithTimeout } from '../lib/api-utils';

const mockFetch = vi.mocked(fetchWithTimeout);

// Helper: build minimal valid options
function makeOptions(overrides: Partial<ResendEmailOptions> = {}): ResendEmailOptions {
  return {
    apiKey: 'test-api-key',
    from: 'Fresh Wax <noreply@freshwax.co.uk>',
    to: 'customer@example.com',
    subject: 'Order Confirmation',
    html: '<p>Thanks for your order</p>',
    template: 'order-confirmation',
    ...overrides,
  };
}

// Helper: build a mock Response
function mockResponse(status: number, body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Helper: build a mock D1 database
function mockDb() {
  const run = vi.fn().mockResolvedValue(undefined);
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, bind, run } as unknown as import('@cloudflare/workers-types').D1Database & {
    prepare: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Helper: run sendResendEmail while advancing fake timers so that
 * internal sleep() calls resolve immediately.
 */
async function sendWithTimers(options: ResendEmailOptions): Promise<import('../lib/email').ResendEmailResult> {
  const promise = sendResendEmail(options);
  // Advance timers to resolve any sleep() calls (max 5s covers all retry delays)
  await vi.advanceTimersByTimeAsync(5000);
  return promise;
}

// =============================================
// sendResendEmail - success path
// =============================================
describe('sendResendEmail - success path', () => {
  it('sends email successfully and returns messageId', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_abc123' }));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_abc123');
    expect(result.retried).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes correct payload to Resend API', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_1' }));

    await sendResendEmail(makeOptions({
      to: ['a@test.com', 'b@test.com'],
      text: 'Plain text body',
      replyTo: 'support@freshwax.co.uk',
      bcc: ['admin@freshwax.co.uk'],
    }));

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'Content-Type': 'application/json',
        },
      }),
      10000,
    );

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]!.body as string);
    expect(body.to).toEqual(['a@test.com', 'b@test.com']);
    expect(body.text).toBe('Plain text body');
    expect(body.reply_to).toBe('support@freshwax.co.uk');
    expect(body.bcc).toEqual(['admin@freshwax.co.uk']);
  });

  it('succeeds even if response JSON is unparseable (2xx status)', async () => {
    // Response.json() will fail for non-JSON
    const resp = new Response('not json', { status: 200 });
    mockFetch.mockResolvedValue(resp);

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(true);
    expect(result.messageId).toBeUndefined();
  });

  it('uses custom timeoutMs', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_1' }));

    await sendResendEmail(makeOptions({ timeoutMs: 5000 }));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      5000,
    );
  });

  it('defaults template to "unknown" when omitted', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_1' }));
    const db = mockDb();

    await sendResendEmail(makeOptions({ template: undefined, db: db as any }));

    // D1 should log with template = 'unknown'
    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[3]).toBe('unknown');
  });
});

// =============================================
// sendResendEmail - validation errors
// =============================================
describe('sendResendEmail - validation errors', () => {
  it('returns error when apiKey is empty', async () => {
    const result = await sendResendEmail(makeOptions({ apiKey: '' }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('RESEND_API_KEY not configured');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('logs to D1 when apiKey is missing and db is provided', async () => {
    const db = mockDb();

    const result = await sendResendEmail(makeOptions({ apiKey: '', db: db as any }));

    expect(result.success).toBe(false);
    expect(db.prepare).toHaveBeenCalled();
  });

  it('returns error when to is empty string', async () => {
    const result = await sendResendEmail(makeOptions({ to: '' }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('No recipient email address');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when to is empty array', async () => {
    const result = await sendResendEmail(makeOptions({ to: [] }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('No recipient email address');
  });
});

// =============================================
// sendResendEmail - retry on 429 (rate limit)
// =============================================
describe('sendResendEmail - retry on 429', () => {
  it('retries once after rate limit and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, { message: 'Rate limited' }))
      .mockResolvedValueOnce(mockResponse(200, { id: 'msg_retry' }));

    const result = await sendWithTimers(makeOptions());

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_retry');
    expect(result.retried).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fails when both attempts return 429', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, {}))
      .mockResolvedValueOnce(mockResponse(429, { message: 'Still rate limited' }));

    const result = await sendWithTimers(makeOptions());

    expect(result.success).toBe(false);
    expect(result.retried).toBe(true);
    expect(result.error).toContain('Retry failed');
    expect(result.error).toContain('429');
  });
});

// =============================================
// sendResendEmail - retry on 5xx
// =============================================
describe('sendResendEmail - retry on 5xx', () => {
  it('retries once on 500 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(500, {}))
      .mockResolvedValueOnce(mockResponse(200, { id: 'msg_recovered' }));

    const result = await sendWithTimers(makeOptions());

    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries once on 503 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(503, {}))
      .mockResolvedValueOnce(mockResponse(200, { id: 'msg_503' }));

    const result = await sendWithTimers(makeOptions());

    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
  });

  it('fails when both attempts return 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(502, {}))
      .mockResolvedValueOnce(mockResponse(500, { message: 'Internal error' }));

    const result = await sendWithTimers(makeOptions());

    expect(result.success).toBe(false);
    expect(result.retried).toBe(true);
    expect(result.error).toContain('Retry failed');
  });
});

// =============================================
// sendResendEmail - retry on network error
// =============================================
describe('sendResendEmail - retry on network error', () => {
  it('retries once on network error and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(mockResponse(200, { id: 'msg_net' }));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fails when both attempts throw network errors', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('DNS lookup failed'))
      .mockRejectedValueOnce(new Error('Connection reset'));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(false);
    expect(result.retried).toBe(true);
    expect(result.error).toContain('DNS lookup failed');
    expect(result.error).toContain('Connection reset');
  });

  it('handles non-Error thrown values', async () => {
    mockFetch
      .mockRejectedValueOnce('string error')
      .mockRejectedValueOnce(42);

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(false);
    expect(result.retried).toBe(true);
  });
});

// =============================================
// sendResendEmail - non-retryable errors
// =============================================
describe('sendResendEmail - non-retryable errors', () => {
  it('does not retry on 400 Bad Request', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, { message: 'Invalid email' }));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(false);
    expect(result.retried).toBe(false);
    expect(result.error).toContain('400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 Unauthorized', async () => {
    mockFetch.mockResolvedValue(mockResponse(401, { message: 'Invalid API key' }));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 403 Forbidden', async () => {
    mockFetch.mockResolvedValue(mockResponse(403, {}));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 422 Unprocessable', async () => {
    mockFetch.mockResolvedValue(mockResponse(422, { message: 'Invalid from' }));

    const result = await sendResendEmail(makeOptions());

    expect(result.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// =============================================
// sendResendEmail - D1 logging
// =============================================
describe('sendResendEmail - D1 logging', () => {
  it('logs successful send to D1', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_d1' }));
    const db = mockDb();

    await sendResendEmail(makeOptions({ db: db as any }));

    expect(db.prepare).toHaveBeenCalledTimes(1);
    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[0]).toBe('msg_d1');           // messageId
    expect(bindArgs[1]).toBe('customer@example.com'); // toEmail
    expect(bindArgs[4]).toBe('sent');             // status
  });

  it('logs retried+sent to D1 with retried status', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, {}))
      .mockResolvedValueOnce(mockResponse(200, { id: 'msg_r' }));
    const db = mockDb();

    await sendWithTimers(makeOptions({ db: db as any }));

    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[4]).toBe('retried');
    expect(bindArgs[5]).toContain('429');  // error from first attempt
  });

  it('logs failure to D1', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, { message: 'Bad request' }));
    const db = mockDb();

    await sendResendEmail(makeOptions({ db: db as any }));

    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[0]).toBeNull();        // no messageId
    expect(bindArgs[4]).toBe('failed');
    expect(bindArgs[5]).toContain('400');
  });

  it('skips D1 logging when db is not provided', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_nodb' }));

    const result = await sendResendEmail(makeOptions({ db: undefined }));

    expect(result.success).toBe(true);
    // No way to directly check D1 wasn't called without a db reference,
    // but the test confirms no error when db is omitted.
  });

  it('uses primary recipient (first of array) for logging', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_arr' }));
    const db = mockDb();

    await sendResendEmail(makeOptions({
      to: ['first@example.com', 'second@example.com'],
      db: db as any,
    }));

    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[1]).toBe('first@example.com');
  });
});

// =============================================
// logEmailToD1 - direct tests
// =============================================
describe('logEmailToD1', () => {
  it('inserts log record into D1', async () => {
    const db = mockDb();

    await logEmailToD1(db as any, {
      messageId: 'msg_123',
      toEmail: 'test@example.com',
      subject: 'Test Subject',
      template: 'test-template',
      status: 'sent',
    });

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO email_logs')
    );
    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[0]).toBe('msg_123');
    expect(bindArgs[1]).toBe('test@example.com');
    expect(bindArgs[2]).toBe('Test Subject');
    expect(bindArgs[3]).toBe('test-template');
    expect(bindArgs[4]).toBe('sent');
    expect(bindArgs[5]).toBeNull();
  });

  it('truncates subject to 500 chars', async () => {
    const db = mockDb();
    const longSubject = 'A'.repeat(600);

    await logEmailToD1(db as any, {
      messageId: null,
      toEmail: 'test@example.com',
      subject: longSubject,
      template: 'test',
      status: 'failed',
      error: 'some error',
    });

    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[2]).toHaveLength(500);
  });

  it('truncates error to 2000 chars', async () => {
    const db = mockDb();
    const longError = 'E'.repeat(3000);

    await logEmailToD1(db as any, {
      messageId: null,
      toEmail: 'test@example.com',
      subject: 'Test',
      template: 'test',
      status: 'failed',
      error: longError,
    });

    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[5]).toHaveLength(2000);
  });

  it('does not throw when D1 insert fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 connection lost'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as any;

    // Should not throw
    await expect(
      logEmailToD1(db, {
        messageId: null,
        toEmail: 'test@example.com',
        subject: 'Test',
        template: 'test',
        status: 'failed',
      })
    ).resolves.toBeUndefined();
  });

  it('uses null for messageId when provided as null', async () => {
    const db = mockDb();

    await logEmailToD1(db as any, {
      messageId: null,
      toEmail: 'test@example.com',
      subject: 'Test',
      template: 'test',
      status: 'failed',
    });

    const bindArgs = db.prepare.mock.results[0].value.bind.mock.calls[0];
    expect(bindArgs[0]).toBeNull();
  });
});
