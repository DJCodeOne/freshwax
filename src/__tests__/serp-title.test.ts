import { describe, it, expect } from 'vitest';
import { truncateSerpTitle } from '../lib/serp-title';

// SEO.astro fits "<title> | FreshWax" into 60 chars, so the base budget is 49.
const BUDGET = 60 - ' | FreshWax'.length;

describe('truncateSerpTitle', () => {
  it('leaves titles that fit untouched', () => {
    expect(truncateSerpTitle('Underground Lair Recordings Hoodie 3', BUDGET)).toBe('Underground Lair Recordings Hoodie 3');
  });

  it('keeps the trailing number so numbered products stay distinct', () => {
    const titles = [1, 2, 3].map((n) => truncateSerpTitle(`Underground Lair Recordings Classic Unisex T-Shirt ${n}`, BUDGET));
    expect(titles).toEqual([
      'Underground Lair Recordings Classic Unisex… 1',
      'Underground Lair Recordings Classic Unisex… 2',
      'Underground Lair Recordings Classic Unisex… 3',
    ]);
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(BUDGET);
  });

  it('cuts at a word boundary instead of mid-word', () => {
    const t = truncateSerpTitle('Stream From Anywhere — DJ-Quality Live Sets Over a Tethered Phone', BUDGET);
    expect(t).toBe('Stream From Anywhere — DJ-Quality Live Sets Over…');
    expect(t.length).toBeLessThanOrEqual(BUDGET);
  });

  it('drops dangling punctuation before the ellipsis', () => {
    expect(truncateSerpTitle('Underground Lair Recordings — Jungle & Drum and Bass Label', BUDGET))
      .toBe('Underground Lair Recordings — Jungle & Drum and…');
  });

  it('still cuts a single very long word', () => {
    const t = truncateSerpTitle('A'.repeat(80), BUDGET);
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBe(BUDGET);
  });
});
