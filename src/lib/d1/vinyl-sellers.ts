// src/lib/d1/vinyl-sellers.ts
// D1 operations for vinyl sellers

import type { FirestoreDoc, D1Database, D1Row } from './types';
import { log } from './types';

export interface D1VinylSeller {
  id: string;  // user_id
  store_name: string | null;
  location: string | null;
  description: string | null;
  discogs_url: string | null;
  shipping_single: number;
  shipping_additional: number;
  ships_international: number;
  shipping_europe: number;
  shipping_europe_additional: number;
  shipping_worldwide: number;
  shipping_worldwide_additional: number;
  data: string;
  created_at: string;
  updated_at: string;
}

// Convert vinyl seller document to D1 row
export function vinylSellerToD1Row(id: string, doc: FirestoreDoc): Partial<D1VinylSeller> {
  return {
    id,
    store_name: doc.storeName || null,
    location: doc.location || null,
    description: doc.description || null,
    discogs_url: doc.discogsUrl || null,
    shipping_single: doc.shippingSingle || 0,
    shipping_additional: doc.shippingAdditional || 0,
    ships_international: doc.shipsInternational ? 1 : 0,
    shipping_europe: doc.shippingEurope || 0,
    shipping_europe_additional: doc.shippingEuropeAdditional || 0,
    shipping_worldwide: doc.shippingWorldwide || 0,
    shipping_worldwide_additional: doc.shippingWorldwideAdditional || 0,
    data: JSON.stringify(doc),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to vinyl seller document
export function d1RowToVinylSeller(row: D1VinylSeller): FirestoreDoc | null {
  let doc;
  try {
    doc = JSON.parse(row.data);
  } catch (error: unknown) {
    log.error('[D1] Error parsing vinyl seller data:', error);
    return null;
  }
  doc.id = row.id;
  doc.userId = row.id;
  return doc;
}

// Get vinyl seller settings by user ID
export async function d1GetVinylSeller(db: D1Database, userId: string): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM vinyl_sellers WHERE id = ?`
    ).bind(userId).first();

    return row ? d1RowToVinylSeller(row as D1VinylSeller) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting vinyl seller:', error);
    return null;
  }
}

// Upsert vinyl seller settings
export async function d1UpsertVinylSeller(db: D1Database, userId: string, doc: FirestoreDoc): Promise<boolean> {
  try {
    const row = vinylSellerToD1Row(userId, doc);

    await db.prepare(`
      INSERT INTO vinyl_sellers (
        id, store_name, location, description, discogs_url,
        shipping_single, shipping_additional, ships_international,
        shipping_europe, shipping_europe_additional,
        shipping_worldwide, shipping_worldwide_additional,
        data, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        store_name = excluded.store_name,
        location = excluded.location,
        description = excluded.description,
        discogs_url = excluded.discogs_url,
        shipping_single = excluded.shipping_single,
        shipping_additional = excluded.shipping_additional,
        ships_international = excluded.ships_international,
        shipping_europe = excluded.shipping_europe,
        shipping_europe_additional = excluded.shipping_europe_additional,
        shipping_worldwide = excluded.shipping_worldwide,
        shipping_worldwide_additional = excluded.shipping_worldwide_additional,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.store_name, row.location, row.description, row.discogs_url,
      row.shipping_single, row.shipping_additional, row.ships_international,
      row.shipping_europe, row.shipping_europe_additional,
      row.shipping_worldwide, row.shipping_worldwide_additional,
      row.data, doc.createdAt || new Date().toISOString(), row.updated_at
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error upserting vinyl seller:', error);
    return false;
  }
}

// Get all vinyl sellers (for admin)
export async function d1GetAllVinylSellers(db: D1Database): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM vinyl_sellers ORDER BY updated_at DESC`
    ).all();

    return (results || []).map((row) => d1RowToVinylSeller(row as D1VinylSeller)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting all vinyl sellers:', error);
    return [];
  }
}

// Get next available collection number
export async function d1GetNextCollectionNumber(db: D1Database): Promise<number> {
  try {
    const result = await db.prepare(
      `SELECT MAX(json_extract(data, '$.collectionNumber')) as max_num FROM vinyl_sellers`
    ).first();

    const maxNum = ((result as D1Row)?.max_num as number) || 0;
    return maxNum + 1;
  } catch (error: unknown) {
    log.error('[D1] Error getting next collection number:', error);
    return 1; // Default to 1 if error
  }
}

// Get vinyl seller by collection number (for public crates page)
export async function d1GetVinylSellerByCollection(db: D1Database, collectionNumber: number): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM vinyl_sellers WHERE json_extract(data, '$.collectionNumber') = ?`
    ).bind(collectionNumber).first();

    return row ? d1RowToVinylSeller(row as D1VinylSeller) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting vinyl seller by collection:', error);
    return null;
  }
}

// Get all vinyl sellers with collection numbers (for public crates sidebar)
export async function d1GetAllCollections(db: D1Database): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM vinyl_sellers
       WHERE json_extract(data, '$.collectionNumber') IS NOT NULL
       ORDER BY json_extract(data, '$.collectionNumber') ASC`
    ).all();

    return (results || []).map((row) => d1RowToVinylSeller(row as D1VinylSeller)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting all collections:', error);
    return [];
  }
}
