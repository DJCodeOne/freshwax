import { describe, it, expect } from 'vitest';
import { formatPrice } from '../lib/format-utils';

// =============================================
// formatPrice
// =============================================
describe('formatPrice', () => {
  it('formats zero as £0.00', () => {
    expect(formatPrice(0)).toBe('£0.00');
  });

  it('formats a typical price with two decimal places', () => {
    expect(formatPrice(9.99)).toBe('£9.99');
  });

  it('formats a whole number with .00', () => {
    expect(formatPrice(100)).toBe('£100.00');
  });

  it('pads a single decimal place to two', () => {
    expect(formatPrice(0.1)).toBe('£0.10');
  });

  it('formats a small fractional amount', () => {
    expect(formatPrice(0.01)).toBe('£0.01');
  });

  it('formats a large price correctly', () => {
    expect(formatPrice(1234.56)).toBe('£1234.56');
  });

  it('rounds to two decimal places when given extra precision', () => {
    expect(formatPrice(19.999)).toBe('£20.00');
  });

  it('handles negative values', () => {
    expect(formatPrice(-5.5)).toBe('£-5.50');
  });
});
