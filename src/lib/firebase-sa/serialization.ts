// src/lib/firebase-sa/serialization.ts
// Firestore REST API value conversion — JS <-> Firestore format

// Convert JS value to Firestore value
export function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

// Convert Firestore value to JS value
export function fromFirestoreValue(value: unknown): unknown {
  const val = value as Record<string, unknown>;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue as string, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    const arrVal = val.arrayValue as Record<string, unknown> | undefined;
    return ((arrVal?.values || []) as unknown[]).map(fromFirestoreValue);
  }
  if ('mapValue' in val) {
    const result: Record<string, unknown> = {};
    const mapVal = val.mapValue as Record<string, unknown> | undefined;
    const fields = (mapVal?.fields || {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fields)) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  return null;
}
