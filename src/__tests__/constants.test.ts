import { describe, it, expect } from 'vitest';
import { SITE_URL, FIREBASE_API_KEY } from '../lib/constants';

// =============================================
// SITE_URL
// =============================================
describe('SITE_URL', () => {
  it('is a string', () => {
    expect(typeof SITE_URL).toBe('string');
  });

  it('is a valid URL', () => {
    expect(() => new URL(SITE_URL)).not.toThrow();
  });

  it('uses HTTPS protocol', () => {
    const url = new URL(SITE_URL);
    expect(url.protocol).toBe('https:');
  });

  it('points to freshwax.co.uk', () => {
    const url = new URL(SITE_URL);
    expect(url.hostname).toBe('freshwax.co.uk');
  });

  it('has no trailing slash', () => {
    // SITE_URL should not have a trailing slash for clean concatenation
    expect(SITE_URL.endsWith('/')).toBe(false);
  });

  it('equals the expected canonical URL', () => {
    expect(SITE_URL).toBe('https://freshwax.co.uk');
  });
});

// =============================================
// FIREBASE_API_KEY
// =============================================
describe('FIREBASE_API_KEY', () => {
  it('is a string', () => {
    expect(typeof FIREBASE_API_KEY).toBe('string');
  });

  it('has a valid Firebase API key', () => {
    // Hardcoded fallback ensures key is always available (public key, safe to expose)
    expect(FIREBASE_API_KEY).toMatch(/^AIza/);
  });
});
