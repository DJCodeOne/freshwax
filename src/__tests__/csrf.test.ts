import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api-utils to control timingSafeCompare behavior
vi.mock('../lib/api-utils', () => ({
  timingSafeCompare: vi.fn((a: string, b: string) => {
    // Replicate actual logic for unit tests
    const maxLen = Math.max(a.length, b.length);
    let result = a.length ^ b.length;
    for (let i = 0; i < maxLen; i++) {
      result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return result === 0;
  }),
}));

import {
  shouldSkipCsrf,
  generateCsrfToken,
  getCsrfCookie,
  getSubmittedCsrfToken,
  validateCsrfToken,
  buildCsrfCookie,
} from '../lib/csrf';

import { timingSafeCompare } from '../lib/api-utils';
const mockTimingSafe = vi.mocked(timingSafeCompare);

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================
// shouldSkipCsrf
// =============================================
describe('shouldSkipCsrf', () => {
  it('returns true for Stripe webhook', () => {
    expect(shouldSkipCsrf('/api/stripe/webhook/')).toBe(true);
  });

  it('returns true for Stripe Connect webhook', () => {
    expect(shouldSkipCsrf('/api/stripe/connect/webhook/')).toBe(true);
  });

  it('returns true for PayPal webhook', () => {
    expect(shouldSkipCsrf('/api/paypal/webhook/')).toBe(true);
  });

  it('returns true for Red5 webhook', () => {
    expect(shouldSkipCsrf('/api/livestream/red5-webhook/')).toBe(true);
  });

  it('returns true for Icecast auth', () => {
    expect(shouldSkipCsrf('/api/icecast-auth/')).toBe(true);
  });

  it('returns true for cron cleanup-reservations', () => {
    expect(shouldSkipCsrf('/api/cron/cleanup-reservations/')).toBe(true);
  });

  it('returns true for cron retry-payouts', () => {
    expect(shouldSkipCsrf('/api/cron/retry-payouts/')).toBe(true);
  });

  it('returns true for cron send-restock-notifications', () => {
    expect(shouldSkipCsrf('/api/cron/send-restock-notifications/')).toBe(true);
  });

  it('returns true for cron image-scan', () => {
    expect(shouldSkipCsrf('/api/cron/image-scan/')).toBe(true);
  });

  it('returns true for cron verification-reminders', () => {
    expect(shouldSkipCsrf('/api/cron/verification-reminders/')).toBe(true);
  });

  it('returns true for cron cleanup-d1', () => {
    expect(shouldSkipCsrf('/api/cron/cleanup-d1/')).toBe(true);
  });

  it('returns true for cron stock-alerts', () => {
    expect(shouldSkipCsrf('/api/cron/stock-alerts/')).toBe(true);
  });

  it('returns true for health index', () => {
    expect(shouldSkipCsrf('/api/health/index/')).toBe(true);
  });

  it('returns true for health payments', () => {
    expect(shouldSkipCsrf('/api/health/payments/')).toBe(true);
  });

  it('returns true for log-error', () => {
    expect(shouldSkipCsrf('/api/log-error/')).toBe(true);
  });

  it('returns true for consent-log', () => {
    expect(shouldSkipCsrf('/api/consent-log/')).toBe(true);
  });

  it('returns false for normal API endpoints', () => {
    expect(shouldSkipCsrf('/api/cart/')).toBe(false);
    expect(shouldSkipCsrf('/api/checkout/')).toBe(false);
    expect(shouldSkipCsrf('/api/auth/login/')).toBe(false);
    expect(shouldSkipCsrf('/api/admin/products/')).toBe(false);
  });

  it('returns false for paths without trailing slash (exact match)', () => {
    expect(shouldSkipCsrf('/api/stripe/webhook')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(shouldSkipCsrf('')).toBe(false);
  });

  it('returns false for partial match', () => {
    expect(shouldSkipCsrf('/api/stripe/webhook/extra/')).toBe(false);
  });
});

// =============================================
// generateCsrfToken
// =============================================
describe('generateCsrfToken', () => {
  it('returns a 32-character hex string', () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique tokens on successive calls', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(50);
  });

  it('always returns exactly 32 characters', () => {
    // Run many times to catch edge cases (e.g. leading zero bytes)
    for (let i = 0; i < 100; i++) {
      expect(generateCsrfToken()).toHaveLength(32);
    }
  });
});

// =============================================
// getCsrfCookie
// =============================================
describe('getCsrfCookie', () => {
  function makeRequest(cookieHeader?: string): Request {
    const headers = new Headers();
    if (cookieHeader !== undefined) {
      headers.set('cookie', cookieHeader);
    }
    return new Request('https://freshwax.co.uk/api/cart/', { headers });
  }

  it('returns token from __csrf cookie', () => {
    const req = makeRequest('__csrf=abc123def456');
    expect(getCsrfCookie(req)).toBe('abc123def456');
  });

  it('returns null when no cookie header', () => {
    const req = makeRequest();
    expect(getCsrfCookie(req)).toBeNull();
  });

  it('returns null when __csrf cookie is absent', () => {
    const req = makeRequest('session=xyz; theme=dark');
    expect(getCsrfCookie(req)).toBeNull();
  });

  it('extracts __csrf from multiple cookies', () => {
    const req = makeRequest('session=abc; __csrf=token123; theme=dark');
    expect(getCsrfCookie(req)).toBe('token123');
  });

  it('handles spaces around cookie name', () => {
    const req = makeRequest('session=abc;  __csrf=token123 ; theme=dark');
    expect(getCsrfCookie(req)).toBe('token123');
  });

  it('returns null for empty __csrf value', () => {
    const req = makeRequest('__csrf=');
    expect(getCsrfCookie(req)).toBeNull();
  });

  it('handles cookie value containing equals signs', () => {
    const req = makeRequest('__csrf=abc=def=ghi');
    expect(getCsrfCookie(req)).toBe('abc=def=ghi');
  });

  it('returns null for empty cookie header', () => {
    const req = makeRequest('');
    expect(getCsrfCookie(req)).toBeNull();
  });
});

// =============================================
// getSubmittedCsrfToken
// =============================================
describe('getSubmittedCsrfToken', () => {
  it('returns token from X-CSRF-Token header', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/', {
      headers: { 'X-CSRF-Token': 'header-token-123' },
    });
    expect(getSubmittedCsrfToken(req)).toBe('header-token-123');
  });

  it('returns token from _csrf body field', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/', {
      method: 'POST',
    });
    expect(getSubmittedCsrfToken(req, { _csrf: 'body-token-456' })).toBe('body-token-456');
  });

  it('prefers header over body field', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/', {
      headers: { 'X-CSRF-Token': 'from-header' },
    });
    expect(getSubmittedCsrfToken(req, { _csrf: 'from-body' })).toBe('from-header');
  });

  it('returns null when neither header nor body has token', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/');
    expect(getSubmittedCsrfToken(req)).toBeNull();
  });

  it('returns null when parsedBody is null', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/');
    expect(getSubmittedCsrfToken(req, null)).toBeNull();
  });

  it('returns null when _csrf in body is not a string', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/');
    expect(getSubmittedCsrfToken(req, { _csrf: 12345 })).toBeNull();
    expect(getSubmittedCsrfToken(req, { _csrf: true })).toBeNull();
    expect(getSubmittedCsrfToken(req, { _csrf: null })).toBeNull();
  });

  it('returns null when body has other fields but no _csrf', () => {
    const req = new Request('https://freshwax.co.uk/api/cart/');
    expect(getSubmittedCsrfToken(req, { quantity: 2, productId: 'abc' })).toBeNull();
  });
});

// =============================================
// validateCsrfToken
// =============================================
describe('validateCsrfToken', () => {
  it('returns true when tokens match', () => {
    const result = validateCsrfToken('abc123', 'abc123');
    expect(result).toBe(true);
    expect(mockTimingSafe).toHaveBeenCalledWith('abc123', 'abc123');
  });

  it('returns false when tokens differ', () => {
    expect(validateCsrfToken('abc', 'xyz')).toBe(false);
  });

  it('returns false when cookieToken is null', () => {
    expect(validateCsrfToken(null, 'token')).toBe(false);
    expect(mockTimingSafe).not.toHaveBeenCalled();
  });

  it('returns false when submittedToken is null', () => {
    expect(validateCsrfToken('token', null)).toBe(false);
    expect(mockTimingSafe).not.toHaveBeenCalled();
  });

  it('returns false when both tokens are null', () => {
    expect(validateCsrfToken(null, null)).toBe(false);
  });

  it('returns false when cookieToken is empty string', () => {
    expect(validateCsrfToken('', 'token')).toBe(false);
    expect(mockTimingSafe).not.toHaveBeenCalled();
  });

  it('returns false when submittedToken is empty string', () => {
    expect(validateCsrfToken('token', '')).toBe(false);
    expect(mockTimingSafe).not.toHaveBeenCalled();
  });

  it('returns false when both are empty strings', () => {
    expect(validateCsrfToken('', '')).toBe(false);
  });

  it('uses timing-safe comparison (delegates to timingSafeCompare)', () => {
    validateCsrfToken('a', 'b');
    expect(mockTimingSafe).toHaveBeenCalledWith('a', 'b');
  });
});

// =============================================
// buildCsrfCookie
// =============================================
describe('buildCsrfCookie', () => {
  it('builds cookie with Secure flag in production', () => {
    const cookie = buildCsrfCookie('token123', true);
    expect(cookie).toContain('__csrf=token123');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=86400');
  });

  it('omits Secure flag in development', () => {
    const cookie = buildCsrfCookie('token123', false);
    expect(cookie).toContain('__csrf=token123');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=86400');
  });

  it('properly formats as semicolon-separated parts', () => {
    const cookie = buildCsrfCookie('abc', true);
    const parts = cookie.split('; ');
    expect(parts[0]).toBe('__csrf=abc');
    expect(parts).toContain('Path=/');
    expect(parts).toContain('SameSite=Lax');
    expect(parts).toContain('HttpOnly');
    expect(parts).toContain('Secure');
    expect(parts).toContain('Max-Age=86400');
  });

  it('sets 24-hour expiry (86400 seconds)', () => {
    const cookie = buildCsrfCookie('tok', false);
    expect(cookie).toContain('Max-Age=86400');
  });
});
