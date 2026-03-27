import { describe, it, expect } from 'vitest';
import { TIMEOUTS, KV_TTL } from '../lib/timeouts';

// =============================================
// TIMEOUTS constant
// =============================================
describe('TIMEOUTS', () => {
  it('has correct API timeout (10 seconds)', () => {
    expect(TIMEOUTS.API).toBe(10000);
  });

  it('has correct LONG timeout (30 seconds)', () => {
    expect(TIMEOUTS.LONG).toBe(30000);
  });

  it('has correct SHORT timeout (5 seconds)', () => {
    expect(TIMEOUTS.SHORT).toBe(5000);
  });

  it('has correct CRON timeout (60 seconds)', () => {
    expect(TIMEOUTS.CRON).toBe(60000);
  });

  it('has correct TOAST timeout (3 seconds)', () => {
    expect(TIMEOUTS.TOAST).toBe(3000);
  });

  it('has correct DEBOUNCE delay (300ms)', () => {
    expect(TIMEOUTS.DEBOUNCE).toBe(300);
  });

  it('has correct ANIMATION duration (500ms)', () => {
    expect(TIMEOUTS.ANIMATION).toBe(500);
  });

  it('has correct API_EXTENDED timeout (15 seconds)', () => {
    expect(TIMEOUTS.API_EXTENDED).toBe(15000);
  });

  it('has correct TICK interval (1 second)', () => {
    expect(TIMEOUTS.TICK).toBe(1000);
  });

  it('has correct OEMBED timeout (8 seconds)', () => {
    expect(TIMEOUTS.OEMBED).toBe(8000);
  });

  it('has all values as positive numbers', () => {
    for (const [key, value] of Object.entries(TIMEOUTS)) {
      expect(value, `TIMEOUTS.${key} should be a positive number`).toBeGreaterThan(0);
      expect(typeof value, `TIMEOUTS.${key} should be a number`).toBe('number');
    }
  });

  it('has all values as integers (no fractional milliseconds)', () => {
    for (const [key, value] of Object.entries(TIMEOUTS)) {
      expect(Number.isInteger(value), `TIMEOUTS.${key} should be an integer`).toBe(true);
    }
  });

  it('maintains ordering: SHORT < API < API_EXTENDED < LONG < CRON', () => {
    expect(TIMEOUTS.SHORT).toBeLessThan(TIMEOUTS.API);
    expect(TIMEOUTS.API).toBeLessThan(TIMEOUTS.API_EXTENDED);
    expect(TIMEOUTS.API_EXTENDED).toBeLessThan(TIMEOUTS.LONG);
    expect(TIMEOUTS.LONG).toBeLessThanOrEqual(TIMEOUTS.CRON);
  });
});

// =============================================
// KV_TTL constant
// =============================================
describe('KV_TTL', () => {
  it('has correct ONE_DAY value (86400 seconds)', () => {
    expect(KV_TTL.ONE_DAY).toBe(86400);
  });

  it('has correct ONE_WEEK value (604800 seconds)', () => {
    expect(KV_TTL.ONE_WEEK).toBe(604800);
  });

  it('has correct ONE_MONTH value (30 days in seconds)', () => {
    expect(KV_TTL.ONE_MONTH).toBe(30 * 24 * 60 * 60);
  });

  it('has correct ONE_YEAR value (365 days in seconds)', () => {
    expect(KV_TTL.ONE_YEAR).toBe(365 * 24 * 60 * 60);
  });

  it('has all values as positive integers', () => {
    for (const [key, value] of Object.entries(KV_TTL)) {
      expect(value, `KV_TTL.${key} should be a positive integer`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `KV_TTL.${key} should be an integer`).toBe(true);
    }
  });

  it('maintains ordering: ONE_DAY < ONE_WEEK < ONE_MONTH < ONE_YEAR', () => {
    expect(KV_TTL.ONE_DAY).toBeLessThan(KV_TTL.ONE_WEEK);
    expect(KV_TTL.ONE_WEEK).toBeLessThan(KV_TTL.ONE_MONTH);
    expect(KV_TTL.ONE_MONTH).toBeLessThan(KV_TTL.ONE_YEAR);
  });
});
