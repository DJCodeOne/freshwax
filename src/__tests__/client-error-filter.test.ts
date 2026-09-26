import { describe, it, expect } from 'vitest';
import { isIgnorableClientError } from '../lib/client-error-filter';

describe('isIgnorableClientError', () => {
  it('drops parse errors from pre-2020 engines (unquoted token) — the bot noise in /admin/errors', () => {
    expect(isIgnorableClientError('Uncaught SyntaxError: Unexpected token .', 'https://freshwax.co.uk/freshwax-cart.js?v=20260405')).toBe(true);
    expect(isIgnorableClientError('Uncaught SyntaxError: Unexpected token <', 'https://freshwax.co.uk/')).toBe(true);
  });

  it('drops errors thrown inside third-party scripts', () => {
    expect(isIgnorableClientError('Uncaught SyntaxError: Unexpected reserved word',
      'https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495')).toBe(true);
    expect(isIgnorableClientError('TypeError: x is undefined', 'https://www.googletagmanager.com/gtag/js')).toBe(true);
  });

  it('keeps modern-engine SyntaxErrors — the signature of a real is:inline regression', () => {
    expect(isIgnorableClientError("Uncaught SyntaxError: Unexpected token ':'", 'https://freshwax.co.uk/')).toBe(false);
    expect(isIgnorableClientError("Uncaught SyntaxError: Unexpected token '<'", 'https://freshwax.co.uk/_astro/x.js')).toBe(false);
    expect(isIgnorableClientError("SyntaxError: expected expression, got '.'", 'https://freshwax.co.uk/')).toBe(false);
  });

  it('keeps ordinary runtime errors from our own pages', () => {
    expect(isIgnorableClientError("Uncaught TypeError: Cannot read properties of undefined (reading 'includes')", 'https://freshwax.co.uk/')).toBe(false);
    expect(isIgnorableClientError('Unhandled rejection: error event on audio', 'https://freshwax.co.uk/live/')).toBe(false);
    expect(isIgnorableClientError('Uncaught SyntaxError: Unexpected reserved word', 'https://freshwax.co.uk/')).toBe(false);
  });

  it('handles a missing url', () => {
    expect(isIgnorableClientError('Something broke', undefined)).toBe(false);
    expect(isIgnorableClientError('Something broke', null)).toBe(false);
  });
});
