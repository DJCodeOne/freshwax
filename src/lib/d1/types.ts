// src/lib/d1/types.ts
// Shared types for D1 database operations

import { createLogger } from '../api-utils';

export const log = createLogger('d1-catalog');

// Shared type alias for Firebase/Firestore document shapes
export type FirestoreDoc = Record<string, unknown>;

// D1 database handle from Cloudflare Workers runtime
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all(): Promise<{ results: D1Row[] | null }>;
  first(): Promise<D1Row | null>;
  run(): Promise<unknown>;
}

export interface D1Row {
  [key: string]: unknown;
}
