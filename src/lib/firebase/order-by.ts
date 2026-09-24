// src/lib/firebase/order-by.ts
// Shared orderBy handling for queryCollection (firebase-rest) and
// saQueryCollection (firebase-sa).
//
// Both helpers take ONE `{ field, direction }` object, but 15 call sites shipped
// the Firestore-REST array shape `[{ field, direction }]`. `options.orderBy.field`
// was then undefined, Firestore rejected the query with 400 "Invalid empty
// property path string", and the helpers swallowed the error and returned [].
// That left partner payout pages, the Connect payout lists, the returns list and
// the webhook log views silently empty (found in the Sep 2026 audit).
//
// normalizeOrderBy accepts both shapes and never produces an empty field path:
// an unusable orderBy is dropped (and logged by the caller) so the query still
// returns rows instead of nothing.
//
// This module has no imports so both query helpers can depend on it without
// creating an import cycle.

export type SortDirection = 'ASCENDING' | 'DESCENDING';

export interface OrderBySpec {
  field: string;
  direction?: SortDirection;
}

/** Accepted by the query helpers: one spec, or the REST-style array (first entry is used). */
export type OrderByOption = OrderBySpec | OrderBySpec[];

/**
 * Resolve an orderBy option to a single `{ field, direction }`, or null when it
 * names no usable field. Also accepts the raw REST field shape
 * `{ field: { fieldPath } }`.
 */
export function normalizeOrderBy(orderBy: unknown): OrderBySpec | null {
  const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  if (!first || typeof first !== 'object') return null;

  const rawField = (first as Record<string, unknown>).field;
  let field = '';
  if (typeof rawField === 'string') {
    field = rawField;
  } else if (rawField && typeof rawField === 'object') {
    const fieldPath = (rawField as Record<string, unknown>).fieldPath;
    if (typeof fieldPath === 'string') field = fieldPath;
  }
  field = field.trim();
  if (!field) return null;

  const direction = (first as Record<string, unknown>).direction;
  return direction === 'ASCENDING' || direction === 'DESCENDING'
    ? { field, direction }
    : { field };
}

const SUPPORTED_QUERY_OPTIONS = new Set(['filters', 'orderBy', 'limit', 'cacheKey', 'cacheTTL', 'skipCache']);

/**
 * Option keys queryCollection does not understand. They are silently ignored by
 * the query builder, e.g. `where` (the live embed page used it, so its "live
 * slot" query returned an arbitrary slot). Callers log these loudly.
 */
export function unsupportedQueryOptions(options: object | null | undefined): string[] {
  if (!options) return [];
  return Object.keys(options).filter((key) => !SUPPORTED_QUERY_OPTIONS.has(key));
}

function sortKey(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

/**
 * In-memory replacement for a Firestore orderBy, for queries whose filter +
 * orderBy combination would need a composite index that does not exist.
 * Dates (ISO strings or Date) and numbers sort by value; rows missing the field
 * go last. Returns a new array.
 */
export function sortRowsByField<T extends Record<string, unknown>>(
  rows: T[],
  field: string,
  direction: SortDirection = 'DESCENDING'
): T[] {
  const sign = direction === 'ASCENDING' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ka = sortKey(a[field]);
    const kb = sortKey(b[field]);
    const aMissing = Number.isNaN(ka);
    const bMissing = Number.isNaN(kb);
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return 0;
      return aMissing ? 1 : -1;
    }
    return (ka - kb) * sign;
  });
}
