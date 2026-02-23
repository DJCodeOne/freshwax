import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  escapeHtml,
  createLogger,
  jsonResponse,
  successResponse,
  errorResponse,
  ApiErrors,
  timingSafeCompare,
  getAdminKey,
  parseJsonBody,
} from '../lib/api-utils';

// =============================================
// escapeHtml
// =============================================
describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less-than and greater-than', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('a "quoted" value')).toBe('a &quot;quoted&quot; value');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns plain text unchanged when no special chars', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('escapes all five chars in one string', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('handles XSS payload with event handler', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('handles nested script injection', () => {
    const payload = '"><script>document.cookie</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<script>');
  });

  it('handles unicode characters without mangling them', () => {
    expect(escapeHtml('cafe\u0301 \u2603')).toBe('cafe\u0301 \u2603');
  });

  it('handles very long strings', () => {
    const long = 'a'.repeat(10000) + '<script>' + 'b'.repeat(10000);
    const result = escapeHtml(long);
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });
});

// =============================================
// timingSafeCompare
// =============================================
describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('secret123', 'secret123')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeCompare('secret123', 'secret456')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeCompare('short', 'muchlongerstring')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });

  it('returns false when one string is empty', () => {
    expect(timingSafeCompare('', 'notempty')).toBe(false);
  });

  it('returns false for strings that differ only in last char', () => {
    expect(timingSafeCompare('abcde1', 'abcde2')).toBe(false);
  });
});

// =============================================
// getAdminKey
// =============================================
describe('getAdminKey', () => {
  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request('https://example.com/api/test/', {
      headers: new Headers(headers),
    });
  }

  it('extracts admin key from body', () => {
    const request = makeRequest();
    expect(getAdminKey(request, { adminKey: 'body-key-123' })).toBe('body-key-123');
  });

  it('extracts admin key from Authorization Bearer header', () => {
    const request = makeRequest({ Authorization: 'Bearer header-key-456' });
    expect(getAdminKey(request)).toBe('header-key-456');
  });

  it('extracts admin key from X-Admin-Key header', () => {
    const request = makeRequest({ 'X-Admin-Key': 'xadmin-key-789' });
    expect(getAdminKey(request)).toBe('xadmin-key-789');
  });

  it('prefers body over headers', () => {
    const request = makeRequest({ Authorization: 'Bearer header-key' });
    expect(getAdminKey(request, { adminKey: 'body-key' })).toBe('body-key');
  });

  it('prefers Authorization header over X-Admin-Key header', () => {
    const request = makeRequest({
      Authorization: 'Bearer auth-header',
      'X-Admin-Key': 'x-admin',
    });
    expect(getAdminKey(request, null)).toBe('auth-header');
  });

  it('returns null when no key provided', () => {
    const request = makeRequest();
    expect(getAdminKey(request)).toBeNull();
  });

  it('returns null for non-Bearer Authorization header', () => {
    const request = makeRequest({ Authorization: 'Basic dXNlcjpwYXNz' });
    expect(getAdminKey(request)).toBeNull();
  });
});

// =============================================
// jsonResponse / successResponse / errorResponse
// =============================================
describe('jsonResponse', () => {
  it('returns JSON response with default 200 status', async () => {
    const res = jsonResponse({ foo: 'bar' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual({ foo: 'bar' });
  });

  it('accepts custom status code', async () => {
    const res = jsonResponse({ created: true }, 201);
    expect(res.status).toBe(201);
  });

  it('merges custom headers', async () => {
    const res = jsonResponse({}, 200, { headers: { 'X-Custom': 'test' } });
    expect(res.headers.get('X-Custom')).toBe('test');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('successResponse', () => {
  it('includes success: true in body', async () => {
    const res = successResponse({ data: 'hello' });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBe('hello');
  });
});

describe('errorResponse', () => {
  it('returns error message with given status', async () => {
    const res = errorResponse('Something broke', 500);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Something broke');
  });
});

// =============================================
// ApiErrors
// =============================================
describe('ApiErrors', () => {
  it('badRequest returns 400', () => {
    expect(ApiErrors.badRequest().status).toBe(400);
  });

  it('unauthorized returns 401', () => {
    expect(ApiErrors.unauthorized().status).toBe(401);
  });

  it('forbidden returns 403', () => {
    expect(ApiErrors.forbidden().status).toBe(403);
  });

  it('notFound returns 404', () => {
    expect(ApiErrors.notFound().status).toBe(404);
  });

  it('methodNotAllowed returns 405', () => {
    expect(ApiErrors.methodNotAllowed().status).toBe(405);
  });

  it('conflict returns 409', () => {
    expect(ApiErrors.conflict().status).toBe(409);
  });

  it('unprocessable returns 422', () => {
    expect(ApiErrors.unprocessable().status).toBe(422);
  });

  it('tooManyRequests returns 429', () => {
    expect(ApiErrors.tooManyRequests().status).toBe(429);
  });

  it('serverError returns 500', () => {
    expect(ApiErrors.serverError().status).toBe(500);
  });

  it('notConfigured includes service name', async () => {
    const res = ApiErrors.notConfigured('Stripe');
    const body = await res.json();
    expect(body.error).toBe('Stripe not configured');
    expect(res.status).toBe(500);
  });

  it('allows custom messages', async () => {
    const res = ApiErrors.badRequest('Invalid email format');
    const body = await res.json();
    expect(body.error).toBe('Invalid email format');
  });
});

// =============================================
// parseJsonBody
// =============================================
describe('parseJsonBody', () => {
  it('parses valid JSON body', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });
    const result = await parseJsonBody(request);
    expect(result).toEqual({ name: 'test' });
  });

  it('returns null for empty body', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: '',
    });
    const result = await parseJsonBody(request);
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: 'not json at all',
    });
    const result = await parseJsonBody(request);
    expect(result).toBeNull();
  });
});

// =============================================
// createLogger
// =============================================
describe('createLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a logger with all four methods', () => {
    const logger = createLogger('test');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('error always logs regardless of config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('test', { enabled: false, level: 'error' });
    logger.error('something failed');
    expect(spy).toHaveBeenCalledWith('[test] something failed');
  });

  it('respects enabled=false (suppresses non-error logs)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('test', { enabled: false });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('respects log level filtering', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('test', { enabled: true, level: 'warn' });
    logger.debug('should not appear');
    logger.warn('should appear');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
