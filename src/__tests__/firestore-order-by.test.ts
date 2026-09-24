import { describe, it, expect } from 'vitest';
import { normalizeOrderBy, unsupportedQueryOptions, sortRowsByField } from '../lib/firebase/order-by';

describe('normalizeOrderBy', () => {
  it('passes a single { field, direction } object through', () => {
    expect(normalizeOrderBy({ field: 'createdAt', direction: 'DESCENDING' }))
      .toEqual({ field: 'createdAt', direction: 'DESCENDING' });
  });

  it('takes the first entry of the REST-style array (the shape that used to 400)', () => {
    expect(normalizeOrderBy([{ field: 'createdAt', direction: 'ASCENDING' }]))
      .toEqual({ field: 'createdAt', direction: 'ASCENDING' });
  });

  it('accepts the raw REST field shape { field: { fieldPath } }', () => {
    expect(normalizeOrderBy([{ field: { fieldPath: 'scheduledFor' }, direction: 'ASCENDING' }]))
      .toEqual({ field: 'scheduledFor', direction: 'ASCENDING' });
  });

  it('omits an unknown direction so the caller default applies', () => {
    expect(normalizeOrderBy({ field: 'timestamp', direction: 'sideways' })).toEqual({ field: 'timestamp' });
  });

  it('never yields an empty field path', () => {
    expect(normalizeOrderBy(undefined)).toBeNull();
    expect(normalizeOrderBy([])).toBeNull();
    expect(normalizeOrderBy({})).toBeNull();
    expect(normalizeOrderBy({ field: '' })).toBeNull();
    expect(normalizeOrderBy({ field: '   ' })).toBeNull();
    expect(normalizeOrderBy({ field: {} })).toBeNull();
  });
});

describe('unsupportedQueryOptions', () => {
  it('accepts every option queryCollection understands', () => {
    expect(unsupportedQueryOptions({
      filters: [], orderBy: { field: 'a' }, limit: 1, cacheKey: 'k', cacheTTL: 1, skipCache: true,
    })).toEqual([]);
  });

  it('flags keys the query builder silently drops', () => {
    // `where` broke the live embed page; `cacheTime` silently fell back to the 5-minute default TTL.
    expect(unsupportedQueryOptions({ where: [], cacheTime: 30000, limit: 1 })).toEqual(['where', 'cacheTime']);
  });

  it('handles missing options', () => {
    expect(unsupportedQueryOptions(undefined)).toEqual([]);
    expect(unsupportedQueryOptions(null)).toEqual([]);
  });
});

describe('sortRowsByField', () => {
  const rows = [
    { id: 'b', createdAt: '2026-08-02T10:00:00.000Z' },
    { id: 'none' },
    { id: 'c', createdAt: '2026-09-01T09:30:00.000Z' },
    { id: 'a', createdAt: '2026-07-15T00:00:00.000Z' },
  ];

  it('sorts ISO dates newest first by default, missing values last', () => {
    expect(sortRowsByField(rows, 'createdAt').map((r) => r.id)).toEqual(['c', 'b', 'a', 'none']);
  });

  it('sorts ascending when asked, still with missing values last', () => {
    expect(sortRowsByField(rows, 'createdAt', 'ASCENDING').map((r) => r.id)).toEqual(['a', 'b', 'c', 'none']);
  });

  it('sorts numbers and Date objects by value', () => {
    expect(sortRowsByField([{ n: 2 }, { n: 10 }, { n: 1 }], 'n').map((r) => r.n)).toEqual([10, 2, 1]);
    const d = (s: string) => ({ at: new Date(s) });
    expect(sortRowsByField([d('2026-01-02'), d('2026-03-04'), d('2025-12-31')], 'at', 'ASCENDING')
      .map((r) => r.at.toISOString().slice(0, 10))).toEqual(['2025-12-31', '2026-01-02', '2026-03-04']);
  });

  it('does not mutate the input', () => {
    const input = [{ t: 1 }, { t: 3 }, { t: 2 }];
    sortRowsByField(input, 't');
    expect(input.map((r) => r.t)).toEqual([1, 3, 2]);
  });
});
