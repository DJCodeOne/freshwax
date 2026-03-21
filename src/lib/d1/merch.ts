// src/lib/d1/merch.ts
// D1 operations for merch

import type { FirestoreDoc, D1Database } from './types';
import { log } from './types';

export interface D1Merch {
  id: string;
  name: string;
  type: string | null;
  price: number;
  stock: number;
  published: number;
  image_url: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

// Extract URL from image (can be string or object with url property)
function extractImageUrl(img: unknown): string | null {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (typeof img === 'object' && img !== null && 'url' in img) return (img as Record<string, unknown>).url as string;
  return null;
}

// Convert Firebase merch document to D1 row
export function merchToD1Row(id: string, doc: FirestoreDoc): Partial<D1Merch> {
  // Extract image URL - handle both string and object formats
  let imageUrl = extractImageUrl(doc.imageUrl) || extractImageUrl(doc.image);
  if (!imageUrl && doc.images && Array.isArray(doc.images)) {
    imageUrl = extractImageUrl(doc.images[0]);
  }

  return {
    id,
    name: doc.name || doc.title || 'Untitled',
    type: doc.type || doc.category || null,
    price: doc.price || 0,
    stock: Math.max(0, (doc.totalStock || doc.stock || doc.quantity || 0) - (doc.reservedStock || 0)),
    published: (doc.published ?? doc.active ?? true) ? 1 : 0,
    image_url: imageUrl,
    data: JSON.stringify(doc),
    created_at: doc.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to merch document
export function d1RowToMerch(row: D1Merch): FirestoreDoc | null {
  let doc;
  try {
    doc = JSON.parse(row.data);
  } catch (error: unknown) {
    log.error('[D1] Error parsing merch data:', error);
    return null;
  }
  doc.id = row.id;
  return doc;
}

export async function d1SearchPublishedMerch(db: D1Database, query: string, limit: number = 50): Promise<FirestoreDoc[]> {
  try {
    const pattern = `%${query}%`;
    const { results } = await db.prepare(
      `SELECT id, data FROM merch WHERE published = 1 AND (
        name LIKE ?1 COLLATE NOCASE OR
        type LIKE ?1 COLLATE NOCASE
      ) ORDER BY created_at DESC LIMIT ?2`
    ).bind(pattern, limit).all();

    return (results || []).map((row) => d1RowToMerch(row as D1Merch)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error searching merch:', error);
    return [];
  }
}

export async function d1GetAllPublishedMerch(db: D1Database, limit: number = 500): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM merch WHERE published = 1 ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();

    return (results || []).map((row) => d1RowToMerch(row as D1Merch)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting published merch:', error);
    return [];
  }
}

export async function d1GetMerchById(db: D1Database, id: string): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      `SELECT id, data FROM merch WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToMerch(row as D1Merch) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting merch:', error);
    return null;
  }
}

export async function d1UpsertMerch(db: D1Database, id: string, doc: FirestoreDoc): Promise<boolean> {
  try {
    const row = merchToD1Row(id, doc);

    await db.prepare(`
      INSERT INTO merch (id, name, type, price, stock, published, image_url, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        price = excluded.price,
        stock = excluded.stock,
        published = excluded.published,
        image_url = excluded.image_url,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.name, row.type, row.price, row.stock, row.published, row.image_url, row.data, row.created_at, row.updated_at
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error upserting merch:', error);
    return false;
  }
}

// Delete merch from D1
export async function d1DeleteMerch(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare('DELETE FROM merch WHERE id = ?').bind(id).run();
    return true;
  } catch (error: unknown) {
    log.error('[D1] Error deleting merch:', error);
    return false;
  }
}

// Get merch by supplier ID (for artist dashboards)
export async function d1GetMerchBySupplierId(db: D1Database, supplierId: string): Promise<FirestoreDoc[]> {
  try {
    // Query using JSON extraction for supplierId
    const { results } = await db.prepare(
      `SELECT id, data FROM merch
       WHERE json_extract(data, '$.supplierId') = ?
       ORDER BY created_at DESC`
    ).bind(supplierId).all();

    return (results || []).map((row) => d1RowToMerch(row as D1Merch)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting merch by supplier:', error);
    return [];
  }
}

// Get merch by supplier name (fallback for artist dashboards)
export async function d1GetMerchBySupplierName(db: D1Database, supplierName: string): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM merch
       WHERE json_extract(data, '$.supplierName') = ?
       ORDER BY created_at DESC`
    ).bind(supplierName).all();

    return (results || []).map((row) => d1RowToMerch(row as D1Merch)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting merch by supplier name:', error);
    return [];
  }
}
