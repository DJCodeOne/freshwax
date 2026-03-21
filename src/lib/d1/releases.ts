// src/lib/d1/releases.ts
// D1 operations for releases

import type { FirestoreDoc, D1Database, D1Row } from './types';
import { log } from './types';

export interface D1Release {
  id: string;
  title: string;
  artist_name: string;
  genre: string;
  release_date: string | null;
  status: string;
  published: number;
  price_per_sale: number;
  track_price: number;
  vinyl_price: number | null;
  vinyl_stock: number;
  cover_url: string | null;
  thumb_url: string | null;
  plays: number;
  downloads: number;
  views: number;
  likes: number;
  rating_avg: number;
  rating_count: number;
  data: string; // Full JSON document
  created_at: string;
  updated_at: string;
}

// Convert Firebase release document to D1 row
export function releaseToD1Row(id: string, doc: FirestoreDoc): Partial<D1Release> {
  const artworkUrl = doc.coverUrl || doc.coverArtUrl || doc.artworkUrl || doc.thumbUrl || doc.imageUrl || null;
  const thumbUrl = doc.thumbUrl || artworkUrl;

  return {
    id,
    title: doc.title || doc.releaseName || 'Untitled',
    artist_name: doc.artistName || doc.artist || 'Unknown Artist',
    genre: doc.genre || 'Jungle & D&B',
    release_date: doc.releaseDate || null,
    status: doc.status || 'pending',
    published: (doc.published || doc.status === 'published') ? 1 : 0,
    price_per_sale: doc.pricePerSale || doc.price || 0,
    track_price: doc.trackPrice || 0,
    vinyl_price: doc.vinylPrice || null,
    vinyl_stock: doc.vinylStock || 0,
    cover_url: artworkUrl,
    thumb_url: thumbUrl,
    plays: doc.plays || doc.playCount || 0,
    downloads: doc.downloads || doc.downloadCount || 0,
    views: doc.views || doc.viewCount || 0,
    likes: doc.likes || doc.likeCount || 0,
    rating_avg: doc.ratings?.average || doc.overallRating?.average || 0,
    rating_count: doc.ratings?.count || doc.overallRating?.count || 0,
    data: JSON.stringify(doc),
    created_at: doc.createdAt || doc.uploadedAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to release document
export function d1RowToRelease(row: D1Release): FirestoreDoc | null {
  let doc;
  try {
    doc = JSON.parse(row.data);
  } catch (error: unknown) {
    log.error('[D1] Error parsing release data:', error);
    return null;
  }
  // Ensure id is set
  doc.id = row.id;
  return doc;
}

export async function d1GetAllPublishedReleases(db: D1Database, limit: number = 500): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM releases_v2 WHERE published = 1 ORDER BY release_date DESC LIMIT ?`
    ).bind(limit).all();

    return (results || []).map((row) => d1RowToRelease(row as D1Release)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting published releases:', error);
    return [];
  }
}

export async function d1SearchPublishedReleases(db: D1Database, query: string, limit: number = 50): Promise<FirestoreDoc[]> {
  try {
    const pattern = `%${query}%`;
    const { results } = await db.prepare(
      `SELECT id, data FROM releases_v2 WHERE published = 1 AND (
        title LIKE ?1 COLLATE NOCASE OR
        artist_name LIKE ?1 COLLATE NOCASE OR
        genre LIKE ?1 COLLATE NOCASE
      ) ORDER BY release_date DESC LIMIT ?2`
    ).bind(pattern, limit).all();

    return (results || []).map((row) => d1RowToRelease(row as D1Release)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error searching releases:', error);
    return [];
  }
}

export async function d1GetReleaseById(db: D1Database, id: string): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      `SELECT id, data FROM releases_v2 WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToRelease(row as D1Release) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting release:', error);
    return null;
  }
}

export async function d1GetReleasesByArtist(db: D1Database, artist: string): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM releases_v2 WHERE artist_name = ? AND published = 1 ORDER BY release_date DESC`
    ).bind(artist).all();

    return (results || []).map((row) => d1RowToRelease(row as D1Release)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting releases by artist:', error);
    return [];
  }
}

export async function d1UpsertRelease(db: D1Database, id: string, doc: FirestoreDoc): Promise<boolean> {
  try {
    const row = releaseToD1Row(id, doc);

    await db.prepare(`
      INSERT INTO releases_v2 (id, title, artist_name, genre, release_date, status, published,
        price_per_sale, track_price, vinyl_price, vinyl_stock, cover_url, thumb_url,
        plays, downloads, views, likes, rating_avg, rating_count, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist_name = excluded.artist_name,
        genre = excluded.genre,
        release_date = excluded.release_date,
        status = excluded.status,
        published = excluded.published,
        price_per_sale = excluded.price_per_sale,
        track_price = excluded.track_price,
        vinyl_price = excluded.vinyl_price,
        vinyl_stock = excluded.vinyl_stock,
        cover_url = excluded.cover_url,
        thumb_url = excluded.thumb_url,
        plays = excluded.plays,
        downloads = excluded.downloads,
        views = excluded.views,
        likes = excluded.likes,
        rating_avg = excluded.rating_avg,
        rating_count = excluded.rating_count,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.title, row.artist_name, row.genre, row.release_date, row.status, row.published,
      row.price_per_sale, row.track_price, row.vinyl_price, row.vinyl_stock, row.cover_url, row.thumb_url,
      row.plays, row.downloads, row.views, row.likes, row.rating_avg, row.rating_count, row.data, row.created_at, row.updated_at
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error upserting release:', error);
    return false;
  }
}
